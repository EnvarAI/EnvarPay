"""Bounded x402 buyer, usable as a Python API, CLI or stdio MCP server."""

from __future__ import annotations

import json
import re
import secrets
from pathlib import Path
from typing import Any

import httpx
from eth_account import Account
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from mcp.types import CallToolResult
from x402 import x402Client
from x402.mcp.client import x402MCPSession
from x402.mcp.types import MCP_PAYMENT_RESPONSE_META_KEY
from x402.mechanisms.evm.exact import ExactEvmClientScheme
from x402.schemas.hooks import PaymentCreatedContext, PaymentCreationContext

from .chain import Chain
from .config import Config, Peer
from .directory import INVOCATION_META, RECOVERY_META, Envar
from .storage import PaymentError, Store, digest, secret_file
from .transport import connect


def validate_quote(config: Config, peer: Peer, tool: str, ctx: PaymentCreationContext) -> int:
    terms, required = ctx.selected_requirements, ctx.payment_required
    if required.x402_version != 2 or terms.scheme != "exact":
        raise PaymentError("Only x402 v2 exact is supported")
    if terms.network != config.network or terms.asset.lower() != config.asset.lower():
        raise PaymentError("Quote network/USDC asset is outside policy")
    if terms.pay_to.lower() != peer.pay_to.lower():
        raise PaymentError("Quote recipient is outside policy")
    if not required.resource or required.resource.url != f"mcp://tool/{tool}":
        raise PaymentError("Quote resource does not match the requested tool")
    extra = terms.extra or {}
    if (
        extra.get("paymentFlow") != "upfront"
        or extra.get("name") != config.token_name
        or extra.get("version") != "2"
        or extra.get("assetTransferMethod", "eip3009") != "eip3009"
    ):
        raise PaymentError("Only upfront USDC EIP-3009 quotes are supported")
    if not re.fullmatch(r"[1-9][0-9]*", terms.amount):
        raise PaymentError("Amount must be a positive integer in atomic USDC units")
    amount = int(terms.amount)
    if amount > config.wallet.max_per_call_atomic:
        raise PaymentError("Quote exceeds the per-call budget")
    if not 1 <= terms.max_timeout_seconds <= config.timeout_seconds:
        raise PaymentError("Quote authorization timeout is outside policy")
    if not config.wallet.payments_enabled:
        raise PaymentError("Payments are disabled; review the config and enable explicitly")
    return amount


class WalletService:
    def __init__(self, config: Config):
        if config.wallet is None:
            raise PaymentError("This command requires [wallet] configuration")
        self.config, self.policy = config, config.wallet
        self.store, self.chain = Store(config.state_dir), Chain(config)
        self.envar = Envar(config.connection, self.store) if config.connection else None

    def peer(self, name: str, tool: str | None = None) -> Peer:
        peer = self.policy.peers.get(name)
        if peer is None or (tool is not None and tool not in peer.tools):
            raise PaymentError("Unknown peer or tool; configure the operator allowlist first")
        return peer

    async def list_tools(self, name: str) -> dict[str, Any]:
        peer = self.peer(name)
        async with connect(peer, self.config.timeout_seconds) as session:
            page = await session.list_tools()
        return {
            "peer": name,
            "tools": [
                tool.model_dump(mode="json", by_alias=True)
                for tool in page.tools
                if tool.name in peer.tools
            ],
        }

    async def call_agent(
        self,
        agent_id: str,
        endpoint_id: str,
        tool: str,
        arguments: dict,
        request_id: str,
        expected_network: str,
        expected_pay_to: str,
        expected_amount_atomic: int,
    ) -> dict[str, Any]:
        matches = [
            name
            for name, peer in self.policy.peers.items()
            if peer.agent_id == agent_id and peer.endpoint_id == endpoint_id and tool in peer.tools
        ]
        if len(matches) != 1:
            raise PaymentError("Approve this Agent, endpoint and tool in the local wallet first")
        peer = self.policy.peers[matches[0]]
        if (
            expected_network != self.config.network
            or expected_pay_to.lower() != peer.pay_to.lower()
        ):
            raise PaymentError("Reviewed receiving terms do not match local wallet policy")
        if (
            type(expected_amount_atomic) is not int
            or not 1 <= expected_amount_atomic <= self.policy.max_per_call_atomic
        ):
            raise PaymentError("Reviewed price is outside the per-call policy")
        return await self.call(
            matches[0], tool, arguments, request_id, expected_amount_atomic=expected_amount_atomic
        )

    async def call(
        self,
        peer_name: str,
        tool: str,
        arguments: dict,
        request_id: str,
        *,
        expected_amount_atomic: int | None = None,
    ) -> dict[str, Any]:
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", request_id):
            raise PaymentError("request_id must be 1-100 letters, digits, underscores or hyphens")
        if not isinstance(arguments, dict) or len(json.dumps(arguments).encode()) > 131072:
            raise PaymentError("Tool arguments must be a bounded JSON object")
        peer = self.peer(peer_name, tool)
        key = "buy:" + request_id
        terms = {
            "peer": peer.model_dump(),
            "network": self.config.network,
            "tool": tool,
            "arguments": arguments,
        }
        if expected_amount_atomic is not None:
            terms["reviewed_amount"] = expected_amount_atomic
        binding = digest(terms)
        existing = self.store.get(key)
        if existing:
            if existing["binding"] != binding:
                raise PaymentError("request_id is already bound to a different request")
            if existing["status"] == "completed":
                return existing["data"]["result"]
            raise PaymentError("Prior attempt is unresolved; inspect status, never re-sign")
        data = {
            "peer": peer_name,
            "peer_config": peer.model_dump(),
            "tool": tool,
            "arguments": arguments,
            "payment_state": "unsigned",
            "recovery_token": secrets.token_urlsafe(32),
            "execution_state": "not_started",
        }
        if self.envar and peer.agent_id and peer.endpoint_id:
            data["invocation_request"] = {
                "target_agent_id": peer.agent_id,
                "endpoint_id": peer.endpoint_id,
                "tool": tool,
                "arguments": arguments,
                "externally_executed": True,
            }
        self.store.claim(key, binding, data)
        invocation_id = None
        if self.envar and data.get("invocation_request"):
            self.store.queue_event(key, "buyer_started", {})
            try:
                invocation_id = await self.envar.create_invocation(key)
            except (httpx.HTTPError, TimeoutError, ValueError, PaymentError):
                pass

        client = x402Client()

        async def before(ctx: PaymentCreationContext) -> None:
            amount = validate_quote(self.config, peer, tool, ctx)
            if expected_amount_atomic is not None and amount != expected_amount_atomic:
                raise PaymentError(
                    "Price changed since review; review the current quote before purchasing"
                )
            await self.chain.check_network()
            self.store.reserve_budget(key, amount, self.policy.max_total_atomic)
            self.store.update(
                key,
                "signing",
                requirements=ctx.selected_requirements.model_dump(mode="json", by_alias=True),
            )

        async def created(ctx: PaymentCreatedContext) -> None:
            self.store.update(
                key,
                "signed",
                payload=ctx.payment_payload.model_dump(mode="json", by_alias=True),
                payment_state="signed",
            )

        client.on_before_payment_creation(before).on_after_payment_creation(created)
        try:
            account = Account.from_key(secret_file(Path(self.policy.key_file)))
            client.register(self.config.network, ExactEvmClientScheme(account))
            async with connect(peer, self.config.timeout_seconds) as session:
                metadata = {RECOVERY_META: data["recovery_token"]}
                if invocation_id:
                    metadata[INVOCATION_META] = {"id": invocation_id}
                session = ObservedSession(session, metadata)
                paid = x402MCPSession(
                    session, client, max_request_timeout_seconds=self.config.timeout_seconds
                )
                result = await paid.call_tool(tool, arguments)
            raw = result.raw_result.model_dump(mode="json", by_alias=True)
            self.store.update(key, "responded", response=raw)
            if result.payment_made:
                response = result.payment_response
                if not response or not getattr(response, "success", False):
                    raise PaymentError("Settlement not confirmed; preserve original authorization")
                self.store.update(key, "settled", transaction=response.transaction)
            return await self.finish(key, request_id, result.raw_result)

        except Exception as error:
            row = self.store.get(key)
            status = "unknown" if row["amount"] else "refused"
            if row["data"].get("payment_state") == "confirmed":
                status = "failed" if row["data"].get("execution_state") == "failed" else "unknown"
            self.store.update(key, status, error_type=type(error).__name__)
            self.report(key, "buyer_failed" if status == "failed" else "buyer_unknown", {})
            if self.envar:
                await self.envar.flush()
            if isinstance(error, PaymentError):
                raise
            raise PaymentError(
                f"Operation {request_id} failed; inspect saved status ({type(error).__name__})"
            ) from None

    def report(self, key, kind, payload):
        if self.envar and self.store.get(key)["data"].get("invocation_request"):
            self.store.queue_event(key, kind, payload)

    async def finish(self, key, request_id, raw):
        data = self.store.get(key)["data"]
        proof = None
        if data.get("payload"):
            tx = data.get("transaction") or (raw.meta or {}).get(
                MCP_PAYMENT_RESPONSE_META_KEY, {}
            ).get("transaction")
            if not tx:
                raise PaymentError("Original settlement is unresolved; do not sign again")
            proof = await self.chain.prove(tx, data["payload"]["payload"]["authorization"])
            self.store.update(
                key, "settled", transaction=tx, proof=proof, payment_state="confirmed"
            )
            if data.get("payment_state") != "confirmed":
                self.report(key, "payment_observed", {"payment": proof})
        if raw.isError:
            self.store.update(key, "failed", execution_state="failed")
            raise PaymentError("Service execution failed; confirmed payment is not a refund")
        value = {
            "request_id": request_id,
            "payment_made": proof is not None,
            "payment": proof,
            "result": raw.model_dump(mode="json", by_alias=True),
        }
        self.store.update(key, "completed", execution_state="completed", result=value)
        self.report(
            key,
            "buyer_received",
            {"result": {k: v for k, v in value["result"].items() if k != "_meta"}},
        )
        if self.envar:
            await self.envar.flush()
        return value

    async def recover(self, request_id):
        key = "buy:" + request_id
        row = self.store.get(key)
        if not row:
            raise PaymentError("Unknown original request")
        data = row["data"]
        if row["status"] == "completed":
            return data["result"]
        if not data.get("payload"):
            return {
                "request_id": request_id,
                "status": row["status"],
                "recovery": "No saved authorization; no new signature created",
            }
        accepted = data["payload"].get("accepted", {})
        if (
            accepted.get("network") != self.config.network
            or accepted.get("asset", "").lower() != self.config.asset.lower()
        ):
            raise PaymentError("Restore the original network before recovering this payment")
        if data.get("response"):
            raw = CallToolResult.model_validate(data["response"])
            if data.get("transaction") or (raw.meta or {}).get(
                MCP_PAYMENT_RESPONSE_META_KEY, {}
            ).get("transaction"):
                return await self.finish(key, request_id, raw)
        peer = Peer.model_validate(data["peer_config"])
        if not peer.recovery:
            raise PaymentError("This peer has no approved result-recovery capability")
        async with connect(peer, self.config.timeout_seconds) as session:
            result = await session.call_tool(
                "envarpay_payment_status",
                {
                    "tool": data["tool"],
                    "arguments": data["arguments"],
                    "payment": data["payload"],
                    "recover": True,
                    "recovery_token": data.get("recovery_token", ""),
                },
            )
        if result.isError or not isinstance(result.structuredContent, dict):
            raise PaymentError("Original service result remains unresolved")
        status = result.structuredContent
        if not status.get("result"):
            return {"request_id": request_id, **status}
        raw = CallToolResult.model_validate(status["result"])
        self.store.update(key, "responded", response=raw.model_dump(mode="json", by_alias=True))
        return await self.finish(key, request_id, raw)


class ObservedSession:
    """Preserve standard x402 handling while attaching optional invocation correlation."""

    def __init__(self, session, metadata):
        self.session, self.metadata = session, metadata

    async def call_tool(self, *args, **kwargs):
        kwargs["meta"] = {**(kwargs.get("meta") or {}), **self.metadata}
        return await self.session.call_tool(*args, **kwargs)


def wallet_mcp(service: WalletService) -> FastMCP:
    settings = service.config.wallet_server
    mcp = FastMCP(
        "envarpay wallet",
        stateless_http=True,
        json_response=True,
        transport_security=TransportSecuritySettings(
            allowed_hosts=settings.allowed_hosts if settings else ["localhost:*", "127.0.0.1:*"]
        ),
    )

    @mcp.tool()
    async def list_paid_tools(peer: str) -> dict[str, Any]:
        """Discover allowed tools and their input schemas at a configured peer."""
        return await service.list_tools(peer)

    @mcp.tool()
    def wallet_policy() -> dict[str, Any]:
        """Read configured public terms and limits; cannot change permissions or expose keys."""
        return {
            "network": service.config.network,
            "payments_enabled": service.policy.payments_enabled,
            "max_per_call_atomic": service.policy.max_per_call_atomic,
            "max_total_atomic": service.policy.max_total_atomic,
            "peers": [
                {
                    "name": name,
                    "agent_id": peer.agent_id,
                    "endpoint_id": peer.endpoint_id,
                    "pay_to": peer.pay_to,
                    "tools": peer.tools,
                }
                for name, peer in service.policy.peers.items()
            ],
        }

    @mcp.tool()
    async def call_paid_tool(
        peer: str, tool: str, arguments: dict, request_id: str
    ) -> dict[str, Any]:
        """Call a configured tool; pay only within operator policy. Reuse request_id on retries."""
        return await service.call(peer, tool, arguments, request_id)

    @mcp.tool()
    async def call_agent(
        agent_id: str,
        endpoint_id: str,
        tool: str,
        arguments: dict,
        request_id: str,
        expected_network: str,
        expected_pay_to: str,
        expected_amount_atomic: int,
    ) -> dict[str, Any]:
        """Purchase a reviewed Agent capability only through an existing operator-approved peer."""
        return await service.call_agent(
            agent_id,
            endpoint_id,
            tool,
            arguments,
            request_id,
            expected_network,
            expected_pay_to,
            expected_amount_atomic,
        )

    @mcp.tool()
    def payment_status(request_id: str) -> list[dict]:
        """Read a prior attempt without creating another signature or exposing secrets."""
        return service.store.public_status("buy:" + request_id)

    @mcp.tool()
    async def recover_payment(request_id: str) -> dict[str, Any]:
        """Query the original payment and saved result; never create another signature."""
        return await service.recover(request_id)

    if service.envar:

        @mcp.tool()
        async def discover_agents(query: str) -> dict[str, Any]:
            """Find Envar candidates without authorizing payment or changing the allowlist."""
            return await service.envar.search(query)

        @mcp.tool()
        async def get_agent(handle: str) -> dict[str, Any]:
            """Read a published Agent profile before selecting an already-approved peer."""
            return await service.envar.get(handle)

    return mcp


def wallet_app(service):
    from .service import wallet_service_app

    settings = service.config.wallet_server
    if not settings:
        raise PaymentError("Configure [wallet_server] before exposing the wallet service")
    return wallet_service_app(wallet_mcp(service), settings, service.config.registration)
