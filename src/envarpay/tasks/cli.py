"""Explicit task subcommands; existing call/private setup flags keep their meaning."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path


def add_parser(sub):
    task = sub.add_parser("task", help="Experimental fixed-price task escrow")
    commands = task.add_subparsers(dest="task_command", required=True)
    for name in (
        "serve",
        "wallet",
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
        if name not in ("serve", "wallet"):
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

    server = FastMCP("envarpay task wallet")

    @server.tool()
    async def create_task(
        peer: str,
        tool: str,
        arguments: dict,
        acceptance: str,
        request_id: str,
        duration: int = 3600,
    ) -> dict:
        """Fund and submit a fixed-price task within operator policy. Reuse original request_id."""
        return await asyncio.to_thread(
            wallet.purchase, peer, tool, arguments, acceptance, request_id, duration
        )

    @server.tool()
    async def task_status(request_id: str) -> dict:
        return await asyncio.to_thread(wallet.status, request_id)

    @server.tool()
    async def task_result(request_id: str) -> dict:
        """Retrieve and verify original deliverable; does not accept its quality."""
        return await asyncio.to_thread(wallet.result, request_id)

    @server.tool()
    async def recover_task(request_id: str) -> dict:
        """Continue only the original task and signed transactions, never create a replacement."""
        return await asyncio.to_thread(wallet.recover, request_id)

    @server.tool()
    async def decide_task(request_id: str, decision: str, reason: str) -> dict:
        """Explicit evaluator decision: accept, reject or expired refund."""
        return await asyncio.to_thread(wallet.decide, request_id, decision, reason)

    return server
