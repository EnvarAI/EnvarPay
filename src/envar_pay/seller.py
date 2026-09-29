"""MCP paid gateway using the official x402 upfront execution wrapper."""

from __future__ import annotations

import asyncio
import time
from contextlib import asynccontextmanager
from contextvars import ContextVar
from typing import Any

import jsonschema
from loguru import logger
from mcp.server import Server
from mcp.server.sse import SseServerTransport
from mcp.server.streamable_http_manager import StreamableHTTPSessionManager
from mcp.server.transport_security import TransportSecuritySettings
from mcp.types import CallToolResult, TextContent, Tool
from starlette.applications import Starlette
from starlette.responses import Response
from starlette.routing import Mount, Route
from x402 import x402ResourceServer
from x402.http import HTTPFacilitatorClient
from x402.mcp.server_async import PaymentWrapperConfig, create_payment_wrapper
from x402.mcp.types import MCPToolContext, MCPToolResult
from x402.mcp.utils import extract_payment_from_meta
from x402.mechanisms.evm.exact import ExactEvmServerScheme
from x402.schemas import ResourceConfig, ResourceInfo
from x402.schemas.hooks import SettleContext, SettleResultContext

from .backend import AgentBackend
from .chain import Chain
from .config import Config, address
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
        self.server = Server("envar-pay seller")
        self.tools: dict[str, Tool] = {}
        self.wrappers: dict[str, Any] = {}
        self.owned: ContextVar[bool] = ContextVar("owns_settlement", default=False)

        @self.server.list_tools()
        async def listing() -> list[Tool]:
            return list(self.tools.values())

        @self.server.call_tool()
        async def calling(name: str, arguments: dict) -> CallToolResult:
            meta = self.server.request_context.meta
            return await self.call(name, arguments, meta.model_dump() if meta else {})

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
        self.store.claim(
            key,
            binding,
            {
                "payload": ctx.payment_payload.model_dump(mode="json", by_alias=True),
                "tool": transport["toolName"],
                "arguments": transport["arguments"],
            },
        )

        self.owned.set(True)

    async def after_settle(self, ctx: SettleResultContext) -> None:
        if not ctx.result.success:
            return
        key = self.payment_key(ctx.payment_payload)
        self.store.update(key, "settled", transaction=ctx.result.transaction)
        proof = await self.chain.prove(
            ctx.result.transaction, ctx.payment_payload.payload["authorization"]
        )
        self.store.update(key, "confirmed", proof=proof)

    async def execute(self, arguments: dict, ctx: MCPToolContext) -> MCPToolResult:
        payload = extract_payment_from_meta({"_meta": ctx.meta})
        key = self.payment_key(payload)
        record = self.store.get(key)
        if not record or record["status"] != "confirmed":
            raise PaymentError("Verified upfront receipt required before execution")
        self.store.update(key, "executing", started_at=time.time())
        result = await self.backend.call(ctx.tool_name, arguments)
        self.store.update(key, "executed", finished_at=time.time())
        return MCPToolResult(
            content=[c.model_dump(mode="json", by_alias=True) for c in result.content],
            is_error=result.isError,
            structured_content=result.structuredContent,
            meta=result.meta,
        )

    async def call(self, name: str, arguments: dict, meta: dict) -> CallToolResult:
        if name not in self.tools:
            return CallToolResult(
                content=[TextContent(type="text", text="Unknown priced tool")], isError=True
            )
        ownership = self.owned.set(False)
        try:
            jsonschema.validate(arguments, self.tools[name].inputSchema)
            payload = extract_payment_from_meta({"_meta": meta})
            record, key = None, None
            if payload:
                key = self.payment_key(payload)
                binding = digest([name, arguments, payload.model_dump(mode="json", by_alias=True)])
                record = self.store.get(key)
                if record:
                    if record["binding"] != binding:
                        raise PaymentError("Authorization is already bound to different arguments")
                    if record["status"] == "completed":
                        return CallToolResult.model_validate(record["data"]["result"])
                    raise PaymentError(
                        "Original attempt is unresolved; no automatic settlement/execution retry"
                    )
            result = native(await self.wrappers[name](arguments, {"toolName": name, "_meta": meta}))
            if key and self.owned.get():
                self.store.update(
                    key,
                    "failed" if result.isError else "completed",
                    result=result.model_dump(mode="json", by_alias=True),
                )
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

    def app(self) -> Starlette:
        security = TransportSecuritySettings(allowed_hosts=self.policy.allowed_hosts)
        manager = StreamableHTTPSessionManager(
            self.server, stateless=True, security_settings=security
        )
        sse = SseServerTransport("/messages/", security_settings=security)

        @asynccontextmanager
        async def lifespan(app: Starlette):
            await self.initialize()
            async with manager.run():
                yield

        async def sse_endpoint(request: Any) -> Response:
            async with sse.connect_sse(request.scope, request.receive, request._send) as streams:
                await self.server.run(*streams, self.server.create_initialization_options())
            return Response()

        class StreamableApp:
            async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
                await manager.handle_request(scope, receive, send)

        return Starlette(
            lifespan=lifespan,
            routes=[
                Route("/mcp", endpoint=StreamableApp()),
                Route("/sse", endpoint=sse_endpoint),
                Mount("/messages/", app=sse.handle_post_message),
            ],
        )
