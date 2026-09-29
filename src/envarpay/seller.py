"""MCP paid gateway using the official x402 upfront execution wrapper."""

from __future__ import annotations

import asyncio
import re
import secrets
import time
import uuid
from contextvars import ContextVar
from typing import Any

from jsonschema.validators import validator_for
from loguru import logger
from mcp.server import Server
from mcp.types import CallToolResult, TextContent, Tool
from referencing import Registry
from x402 import x402ResourceServer
from x402.http import HTTPFacilitatorClient
from x402.mcp.server_async import PaymentWrapperConfig, create_payment_wrapper
from x402.mcp.types import MCP_PAYMENT_RESPONSE_META_KEY, MCPToolContext, MCPToolResult
from x402.mcp.utils import extract_payment_from_meta
from x402.mechanisms.evm.exact import ExactEvmServerScheme
from x402.schemas import PaymentPayload, ResourceConfig, ResourceInfo, SettleResponse
from x402.schemas.hooks import SettleContext, SettleResultContext

from .backend import AgentBackend
from .chain import Chain
from .config import Config, address
from .directory import INVOCATION_META, RECOVERY_META, Envar
from .storage import PaymentError, Store, digest


def native(result: MCPToolResult) -> CallToolResult:
    return CallToolResult(
        content=result.content,
        isError=result.is_error,
        structuredContent=result.structured_content,
        _meta=result.meta,
    )


class PaidServer:
    def __init__(self, config: Config):
        if not config.seller:
            raise PaymentError("This command requires [seller] configuration")
        self.config, self.policy = config, config.seller
        self.store, self.chain = Store(config.state_dir), Chain(config)
        self.backend = AgentBackend(self.policy.backend, config.timeout_seconds)
        self.facilitator = HTTPFacilitatorClient({"url": self.policy.facilitator_url})
        self.resource = x402ResourceServer(self.facilitator)
        self.resource.register(config.network, ExactEvmServerScheme())
        self.resource.on_before_settle(self.before_settle).on_after_settle(self.after_settle)
        self.server = Server("envarpay seller")
        self.current = None
        self.applied_digest = ""
        self.tools: dict[str, Tool] = {}
        self.wrappers: dict[str, Any] = {}
        self.envar = Envar(config.connection, self.store) if config.connection else None
        self.owned: ContextVar[bool] = ContextVar("owns_settlement", default=False)

        @self.server.list_tools()
        async def listing() -> list[Tool]:
            return [
                *(self.current or self).tools.values(),
                Tool(
                    name="envarpay_payment_status",
                    description="Recover the original paid result without paying again.",
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "tool": {"type": "string"},
                            "arguments": {"type": "object"},
                            "payment": {"type": "object"},
                            "recover": {"type": "boolean"},
                            "recovery_token": {"type": "string"},
                        },
                        "required": ["tool", "arguments", "payment"],
                        "additionalProperties": False,
                    },
                ),
            ]

        @self.server.call_tool()
        async def calling(name: str, arguments: dict) -> CallToolResult:
            meta = self.server.request_context.meta
            return await (self.current or self).call(
                name, arguments, meta.model_dump() if meta else {}
            )

    @staticmethod
    def payment_key(payload: Any) -> str:
        auth = payload.payload["authorization"]
        return "sell:" + digest(
            [
                payload.accepted.network,
                payload.accepted.asset.lower(),
                auth["from"].lower(),
                auth["nonce"].lower(),
            ]
        )

    async def initialize(self) -> None:
        await self.chain.check_network()
        await asyncio.to_thread(self.resource.initialize)
        if "envarpay_payment_status" in self.policy.tools:
            raise PaymentError("The payment-status tool name is reserved")
        available = {tool.name: tool for tool in await self.backend.list_tools()}
        if not self.policy.tools.keys() <= available.keys():
            raise PaymentError("A priced tool is missing from the backend")
        for name, price in self.policy.tools.items():
            tool = available[name].model_copy(deep=True)
            tool.description = (tool.description or name) + " (x402 upfront USDC payment required)"
            self.tools[name] = tool
            accepts = self.resource.build_payment_requirements(
                ResourceConfig(
                    scheme="exact",
                    network=self.config.network,
                    pay_to=self.policy.pay_to,
                    price={
                        "amount": str(price.amount_atomic),
                        "asset": self.config.asset,
                        "extra": {
                            "name": self.config.token_name,
                            "version": "2",
                            "paymentFlow": "upfront",
                        },
                    },
                    max_timeout_seconds=self.config.timeout_seconds,
                    extra={"paymentFlow": "upfront"},
                )
            )
            self.wrappers[name] = create_payment_wrapper(
                self.resource,
                PaymentWrapperConfig(
                    accepts=accepts,
                    resource=ResourceInfo(url=f"mcp://tool/{name}", description=tool.description),
                ),
            )(self.execute)

    async def before_settle(self, ctx: SettleContext) -> None:
        transport = ctx.transport_context
        if ctx.phase != "before-handler" or not transport:
            raise PaymentError("Upfront settlement context is required")
        auth = ctx.payment_payload.payload["authorization"]
        if (
            ctx.payment_payload.x402_version != 2
            or ctx.requirements.network != self.config.network
            or ctx.requirements.asset.lower() != self.config.asset.lower()
            or address(auth["to"]) != self.policy.pay_to
            or str(auth["value"]) != ctx.requirements.amount
        ):
            raise PaymentError("Authorization must match the exact priced recipient and amount")
        # Upfront SDK flow can defer verification; authenticate before reserving a nonce.
        verification = await self.facilitator.verify(ctx.payment_payload, ctx.requirements)
        if not verification.is_valid:
            raise PaymentError("Facilitator rejected the authorization before settlement")
        key = self.payment_key(ctx.payment_payload)
        binding = digest(
            [
                transport["toolName"],
                transport["arguments"],
                ctx.payment_payload.model_dump(mode="json", by_alias=True),
            ]
        )
        invocation = transport.get("meta", {}).get(INVOCATION_META) or {}
        invocation_id = str(uuid.UUID(invocation["id"])) if invocation.get("id") else None
        recovery_token = transport.get("meta", {}).get(RECOVERY_META, "")
        if recovery_token and not re.fullmatch(r"[A-Za-z0-9_-]{32,128}", recovery_token):
            raise PaymentError("Invalid recovery credential")
        start_block = int(await self.chain.rpc("eth_blockNumber", []), 16)
        self.store.claim(
            key,
            binding,
            {
                "payload": ctx.payment_payload.model_dump(mode="json", by_alias=True),
                "tool": transport["toolName"],
                "start_block": start_block,
                "recovery_token_hash": digest(recovery_token) if recovery_token else "",
                "payment_state": "unknown",
                "execution_state": "not_started",
                "invocation_id": invocation_id,
                "arguments": transport["arguments"],
            },
        )

        self.owned.set(True)

    async def after_settle(self, ctx: SettleResultContext) -> None:
        if not ctx.result.success:
            return
        key = self.payment_key(ctx.payment_payload)
        self.store.update(
            key,
            "settled",
            transaction=ctx.result.transaction,
            settlement_response=ctx.result.model_dump(
                mode="json", by_alias=True, exclude_none=True
            ),
        )
        proof = await self.chain.prove(
            ctx.result.transaction, ctx.payment_payload.payload["authorization"]
        )
        self.store.update(key, "confirmed", proof=proof, payment_state="confirmed")
        self.report(key, "payment_observed", {"payment": proof})

    def report(self, key, kind, payload):
        if self.envar and self.store.get(key)["data"].get("invocation_id"):
            self.store.queue_event(key, kind, payload)

    def saved_result(self, record):
        data = record["data"]
        result = CallToolResult.model_validate(data["result"])
        if data.get("transaction") and data.get("payment_state") == "confirmed":
            result.meta = {
                **(result.meta or {}),
                MCP_PAYMENT_RESPONSE_META_KEY: data.get("settlement_response")
                or SettleResponse(
                    success=True,
                    transaction=data["transaction"],
                    network=self.config.network,
                    payer=data["payload"]["payload"]["authorization"]["from"],
                ).model_dump(mode="json", by_alias=True, exclude_none=True),
            }
        return result

    async def execute_saved(self, key):
        if not self.store.update(
            key,
            "executing",
            expected={"confirmed"},
            execution_state="executing",
            started_at=time.time(),
        ):
            raise PaymentError("Original execution already started; query its saved status")
        data = self.store.get(key)["data"]
        try:
            result = await self.backend.call(data["tool"], data["arguments"])
        except BaseException:
            self.store.update(key, "unknown", execution_state="unknown")
            self.report(key, "execution_unknown", {})
            raise
        self.store.update(
            key,
            "failed" if result.isError else "completed",
            execution_state="failed" if result.isError else "completed",
            result=result.model_dump(mode="json", by_alias=True),
            finished_at=time.time(),
        )
        self.report(key, "seller_failed" if result.isError else "seller_completed", {})
        return self.saved_result(self.store.get(key))

    async def execute(self, arguments: dict, ctx: MCPToolContext) -> MCPToolResult:
        payload = extract_payment_from_meta({"_meta": ctx.meta})
        result = await self.execute_saved(self.payment_key(payload))
        return MCPToolResult(
            content=[c.model_dump(mode="json", by_alias=True) for c in result.content],
            is_error=result.isError,
            structured_content=result.structuredContent,
            meta=result.meta,
        )

    @staticmethod
    def authorize_recovery(record, token):
        expected = record["data"].get("recovery_token_hash")
        if (
            not expected
            or not isinstance(token, str)
            or not secrets.compare_digest(expected, digest(token))
        ):
            raise PaymentError(
                "Private recovery credential required; chain data does not grant result access"
            )

    async def payment_status(self, arguments):
        payload = PaymentPayload.model_validate(arguments["payment"])
        key = self.payment_key(payload)
        record = self.store.get(key)
        binding = digest(
            [
                arguments["tool"],
                arguments["arguments"],
                payload.model_dump(mode="json", by_alias=True),
            ]
        )
        if not record or record["binding"] != binding:
            raise PaymentError("Original signed payment and exact request are required")
        self.authorize_recovery(record, arguments.get("recovery_token"))
        data = record["data"]
        if "result" in data:
            return {
                "status": record["status"],
                "result": self.saved_result(record).model_dump(
                    mode="json", by_alias=True, exclude_none=True
                ),
            }
        if arguments.get("recover") and record["status"] in {"reserved", "settled", "confirmed"}:
            tx = data.get("transaction")
            if not tx:
                tx = await self.chain.find_authorization(
                    payload.payload["authorization"], data["start_block"]
                )
            if tx:
                proof = await self.chain.prove(tx, payload.payload["authorization"])
                self.store.update(
                    key,
                    "confirmed",
                    expected={"reserved", "settled", "confirmed"},
                    transaction=tx,
                    proof=proof,
                    payment_state="confirmed",
                )
                self.report(key, "payment_observed", {"payment": proof})
                await self.execute_saved(key)
                return await self.payment_status({**arguments, "recover": False})
        if self.envar:
            await self.envar.flush()
        return {
            "status": record["status"],
            "payment_state": data.get("payment_state"),
            "execution_state": data.get("execution_state"),
            "transaction": data.get("transaction"),
        }

    async def call(self, name: str, arguments: dict, meta: dict) -> CallToolResult:
        if name == "envarpay_payment_status":
            try:
                value = await self.payment_status(arguments)
                return CallToolResult(content=[], structuredContent=value)
            except Exception:
                return CallToolResult(
                    content=[TextContent(type="text", text="Original payment is unresolved")],
                    isError=True,
                )
        if name not in self.tools:
            return CallToolResult(
                content=[TextContent(type="text", text="Unknown priced tool")], isError=True
            )
        ownership = self.owned.set(False)
        try:
            validator_for(self.tools[name].inputSchema)(
                self.tools[name].inputSchema, registry=Registry()
            ).validate(arguments)
            payload = extract_payment_from_meta({"_meta": meta})
            record, key = None, None
            if payload:
                key = self.payment_key(payload)
                binding = digest([name, arguments, payload.model_dump(mode="json", by_alias=True)])
                record = self.store.get(key)
                if record:
                    if record["binding"] != binding:
                        raise PaymentError("Authorization is already bound to different arguments")
                    self.authorize_recovery(record, meta.get(RECOVERY_META))
                    if "result" in record["data"]:
                        return self.saved_result(record)
                    raise PaymentError(
                        "Original attempt is unresolved; no automatic settlement/execution retry"
                    )
            result = native(await self.wrappers[name](arguments, {"toolName": name, "_meta": meta}))
            if key and self.owned.get():
                self.store.update(
                    key,
                    None,
                    response=result.model_dump(mode="json", by_alias=True),
                )
            if self.envar:
                await self.envar.flush()
            return result
        except Exception as error:
            logger.warning("Tool refused: {}", type(error).__name__)
            message = (
                str(error)
                if isinstance(error, PaymentError)
                else "Invalid request or service error"
            )
            return CallToolResult(content=[TextContent(type="text", text=message)], isError=True)
        finally:
            self.owned.reset(ownership)

    async def synchronize(self, config_path):
        if self.envar:
            if self.config.connection.accept_receiving_updates:
                from .receiving import apply_receiving

                await apply_receiving(self, config_path)
            await self.envar.flush()

    def app(self, *, config_path=None):
        from .service import service_app

        return service_app(
            self.server,
            self.initialize,
            allowed_hosts=self.policy.allowed_hosts,
            registration=self.config.registration,
            tick=(lambda: self.synchronize(config_path)) if self.envar else None,
        )
