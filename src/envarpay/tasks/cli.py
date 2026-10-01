"""Explicit task subcommands; existing call/private setup flags keep their meaning."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any


def add_parser(sub):
    task = sub.add_parser("task", help="Experimental fixed-price task escrow")
    commands = task.add_subparsers(dest="task_command", required=True)
    for name in (
        "serve",
        "wallet",
        "wallet-serve",
        "create",
        "status",
        "result",
        "recover",
        "accept",
        "reject",
        "refund",
    ):
        p = commands.add_parser(name)
        p.add_argument("--config", type=Path, required=True)
        if name not in ("serve", "wallet", "wallet-serve"):
            p.add_argument("--request-id", required=True)
        if name == "create":
            p.add_argument("--peer", required=True)
            p.add_argument("--tool", required=True)
            p.add_argument("--arguments", default="{}")
            p.add_argument("--acceptance", required=True)
            p.add_argument("--duration", type=int, default=3600)
        if name in ("accept", "reject", "refund"):
            p.add_argument("--reason", required=True)


def run(args):
    from importlib.util import find_spec

    from ..storage import PaymentError

    if find_spec("web3") is None:
        raise PaymentError("Task mode requires the optional task extra: install envarpay[task]")
    from .config import load_task_config

    cfg = load_task_config(args.config)
    if args.task_command == "serve":
        import uvicorn

        from .server import TaskServer

        uvicorn.run(TaskServer(cfg).app(), host=cfg.host, port=cfg.port, log_level="warning")
        return
    from .client import TaskWallet

    wallet = TaskWallet(cfg)
    if args.task_command == "wallet":
        wallet_mcp(wallet).run(transport="stdio")
        return
    if args.task_command == "wallet-serve":
        import uvicorn

        from ..service import wallet_service_app

        settings = cfg.wallet_server
        if not settings or cfg.backend:
            raise PaymentError("Configure a separate authenticated task wallet_server")
        uvicorn.run(
            wallet_service_app(wallet_mcp(wallet), settings, cfg.registration),
            host=settings.host,
            port=settings.port,
            log_level="warning",
        )
        return
    if args.task_command == "create":
        value = wallet.purchase(
            args.peer,
            args.tool,
            json.loads(args.arguments),
            args.acceptance,
            args.request_id,
            args.duration,
        )
    elif args.task_command in ("accept", "reject", "refund"):
        value = wallet.decide(args.request_id, args.task_command, args.reason)
    else:
        value = getattr(wallet, args.task_command)(args.request_id)
    print(json.dumps(value, ensure_ascii=False, indent=2))


def wallet_mcp(wallet):
    from mcp.server.fastmcp import FastMCP
    from mcp.server.transport_security import TransportSecuritySettings

    settings = wallet.config.wallet_server
    server = FastMCP(
        "envarpay task wallet",
        stateless_http=True,
        json_response=True,
        transport_security=TransportSecuritySettings(allowed_hosts=settings.allowed_hosts)
        if settings
        else None,
    )

    @server.tool()
    def task_policy() -> dict[str, Any]:
        """Inspect operator-approved task terms without signing or exposing credentials."""
        cfg = wallet.config
        return {
            "chain_id": cfg.chain_id,
            "contract": cfg.contract,
            "token": cfg.token,
            "signing_enabled": cfg.signing_enabled,
            "evaluator_enabled": cfg.evaluator_enabled,
            "max_per_task_atomic": cfg.max_per_task_atomic,
            "max_total_atomic": cfg.max_total_atomic,
            "peers": [
                {
                    "name": name,
                    "provider": peer.provider,
                    "tools": peer.tools,
                    "agent_id": peer.agent_id,
                    "endpoint_id": peer.endpoint_id,
                }
                for name, peer in cfg.peers.items()
            ],
        }

    @server.tool()
    async def create_reviewed_task(
        peer: str,
        tool: str,
        arguments: dict,
        acceptance: str,
        request_id: str,
        terms: dict,
        duration: int = 3600,
    ) -> dict[str, Any]:
        """Fund only the task terms explicitly reviewed by the operator; testnet only."""
        from ..storage import PaymentError

        cfg, selected = wallet.config, wallet.peer(peer)
        expected = {
            "chain_id": cfg.chain_id,
            "contract": cfg.contract,
            "token": cfg.token,
            "provider": selected.provider,
            "amount_atomic": selected.tools.get(tool),
        }
        if selected.agent_id and selected.endpoint_id:
            expected.update(agent_id=selected.agent_id, endpoint_id=selected.endpoint_id)
        if terms != expected or tool not in selected.tools:
            raise PaymentError("Task terms changed since review; inspect the current task policy")
        return await asyncio.to_thread(
            wallet.purchase,
            peer,
            tool,
            arguments,
            acceptance,
            request_id,
            duration,
            verify_live_terms=True,
        )

    @server.tool()
    async def create_task(
        peer: str,
        tool: str,
        arguments: dict,
        acceptance: str,
        request_id: str,
        duration: int = 3600,
    ) -> dict[str, Any]:
        """Fund and submit a fixed-price task within operator policy. Reuse original request_id."""
        return await asyncio.to_thread(
            wallet.purchase, peer, tool, arguments, acceptance, request_id, duration
        )

    @server.tool()
    async def task_status(request_id: str) -> dict[str, Any]:
        return await asyncio.to_thread(wallet.status, request_id)

    @server.tool()
    async def task_result(request_id: str) -> dict[str, Any]:
        """Retrieve and verify original deliverable; does not accept its quality."""
        return await asyncio.to_thread(wallet.result, request_id)

    @server.tool()
    async def recover_task(request_id: str) -> dict[str, Any]:
        """Continue only the original task and signed transactions, never create a replacement."""
        return await asyncio.to_thread(wallet.recover, request_id)

    @server.tool()
    async def decide_task(request_id: str, decision: str, reason: str) -> dict[str, Any]:
        """Explicit evaluator decision: accept, reject or expired refund."""
        return await asyncio.to_thread(wallet.decide, request_id, decision, reason)

    return server
