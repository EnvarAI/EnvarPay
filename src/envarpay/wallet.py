"""Bounded x402 buyer, usable as a Python API, CLI or stdio MCP server."""

from __future__ import annotations

import re
from pathlib import Path

from eth_account import Account
from mcp.server.fastmcp import FastMCP
from x402 import x402Client
from x402.mcp.client import x402MCPSession
from x402.mechanisms.evm.exact import ExactEvmClientScheme
from x402.schemas.hooks import PaymentCreatedContext, PaymentCreationContext

from .chain import Chain
from .config import Config, Peer
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

    def peer(self, name: str, tool: str | None = None) -> Peer:
        peer = self.policy.peers.get(name)
        if peer is None or (tool is not None and tool not in peer.tools):
            raise PaymentError("Unknown peer or tool; configure the operator allowlist first")
        return peer

    async def list_tools(self, name: str) -> dict:
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

    async def call(self, peer_name: str, tool: str, arguments: dict, request_id: str) -> dict:
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", request_id):
            raise PaymentError("request_id must be 1-100 letters, digits, underscores or hyphens")
        peer = self.peer(peer_name, tool)
        key = "buy:" + request_id
        binding = digest(
            {
                "peer": peer.model_dump(),
                "network": self.config.network,
                "tool": tool,
                "arguments": arguments,
            }
        )
        existing = self.store.get(key)
        if existing:
            if existing["binding"] != binding:
                raise PaymentError("request_id is already bound to a different request")
            if existing["status"] == "completed":
                return existing["data"]["result"]
            raise PaymentError("Prior attempt is unresolved; inspect status, never re-sign")
        self.store.claim(key, binding, {"peer": peer_name, "tool": tool, "arguments": arguments})
        client = x402Client()

        async def before(ctx: PaymentCreationContext) -> None:
            amount = validate_quote(self.config, peer, tool, ctx)
            await self.chain.check_network()
            self.store.reserve_budget(key, amount, self.policy.max_total_atomic)
            self.store.update(
                key,
                "signing",
                requirements=ctx.selected_requirements.model_dump(mode="json", by_alias=True),
            )

        async def created(ctx: PaymentCreatedContext) -> None:
            self.store.update(
                key, "signed", payload=ctx.payment_payload.model_dump(mode="json", by_alias=True)
            )

        client.on_before_payment_creation(before).on_after_payment_creation(created)
        try:
            account = Account.from_key(secret_file(Path(self.policy.key_file)))
            client.register(self.config.network, ExactEvmClientScheme(account))
            async with connect(peer, self.config.timeout_seconds) as session:
                paid = x402MCPSession(
                    session, client, max_request_timeout_seconds=self.config.timeout_seconds
                )
                result = await paid.call_tool(tool, arguments)
            raw = result.raw_result.model_dump(mode="json", by_alias=True)
            self.store.update(key, "responded", response=raw)
            proof = None
            if result.payment_made:
                response = result.payment_response
                if not response or not getattr(response, "success", False):
                    raise PaymentError("Settlement not confirmed; preserve original authorization")
                self.store.update(key, "settled", transaction=response.transaction)
                original = self.store.get(key)["data"]["payload"]
                proof = await self.chain.prove(
                    response.transaction, original["payload"]["authorization"]
                )
            if result.is_error:
                raise PaymentError("The service returned an error; inspect status before retrying")
            value = {
                "request_id": request_id,
                "payment_made": result.payment_made,
                "payment": proof,
                "result": raw,
            }
            self.store.update(key, "completed", result=value)
            return value
        except Exception as error:
            row = self.store.get(key)
            status = "unknown" if row["amount"] else "refused"
            self.store.update(key, status, error_type=type(error).__name__)
            if isinstance(error, PaymentError):
                raise
            raise PaymentError(
                f"Operation {request_id} failed; inspect saved status ({type(error).__name__})"
            ) from None


def wallet_mcp(service: WalletService) -> FastMCP:
    mcp = FastMCP("envarpay wallet")

    @mcp.tool()
    async def list_paid_tools(peer: str) -> dict:
        """Discover allowed tools and their input schemas at a configured peer."""
        return await service.list_tools(peer)

    @mcp.tool()
    async def call_paid_tool(peer: str, tool: str, arguments: dict, request_id: str) -> dict:
        """Call a configured tool; pay only within operator policy. Reuse request_id on retries."""
        return await service.call(peer, tool, arguments, request_id)

    @mcp.tool()
    def payment_status(request_id: str) -> list[dict]:
        """Read a prior attempt without creating another signature or exposing secrets."""
        return service.store.public_status("buy:" + request_id)

    return mcp
