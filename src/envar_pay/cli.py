"""Command-line setup, serving and read-only diagnostics."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from importlib.metadata import version
from pathlib import Path

from eth_account import Account
from loguru import logger
from pydantic import ValidationError

from . import __version__
from .chain import Chain
from .config import address, load_config
from .storage import PaymentError, Store


def write_new(path: Path, text: str) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as file:
        file.write(text)


def initialize(directory: Path, pay_to: str, backend: str) -> dict:
    pay_to = address(pay_to)
    directory = directory.expanduser().resolve()
    directory.mkdir(parents=True, mode=0o700, exist_ok=True)
    if any(directory.iterdir()):
        raise PaymentError("Initialization requires an empty directory; nothing was overwritten")
    write_new(directory / ".gitignore", "*.key\n*-state/\n*.sqlite3*\n.env*\n")
    backend_config = (
        """kind = "hermes"
model = "YOUR_MODEL"
base_url = "https://YOUR_MODEL_ENDPOINT/v1"
provider = "custom"
api_key_env = "LLM_API_KEY"
system_prompt = "Answer the buyer's request."
toolsets = []
"""
        if backend == "hermes"
        else """kind = "mcp"
[seller.backend.upstream]
transport = "streamable-http"
url = "http://127.0.0.1:8000/mcp"
"""
    )
    write_new(
        directory / "seller.toml",
        f'''schema_version = 1
network = "eip155:84532"
rpc_url = "https://sepolia.base.org"
state_dir = "./seller-state"

[seller]
pay_to = "{pay_to}"
host = "127.0.0.1"
port = 4020

[seller.tools.ask_agent]
amount_atomic = 10000

[seller.backend]
{backend_config}''',
    )
    write_new(
        directory / "buyer.toml",
        f'''schema_version = 1
network = "eip155:84532"
rpc_url = "https://sepolia.base.org"
state_dir = "./buyer-state"

[wallet]
key_file = "./buyer.key"
payments_enabled = false
max_per_call_atomic = 10000
max_total_atomic = 10000

[wallet.peers.seller]
transport = "streamable-http"
url = "http://127.0.0.1:4020/mcp"
pay_to = "{pay_to}"
tools = ["ask_agent"]
''',
    )
    return {
        "directory": str(directory),
        "payments_enabled": False,
        "next": "Configure the backend/model, provision buyer.key, and review payment policy",
    }


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(prog="envar-pay", description="MCP + x402 agent payments")
    root.add_argument("--version", action="version", version=__version__)
    sub = root.add_subparsers(dest="command", required=True)
    init = sub.add_parser(
        "init", help="Generate editable seller/buyer configs; payments default off"
    )
    init.add_argument("--directory", type=Path, required=True)
    init.add_argument("--pay-to", required=True)
    init.add_argument("--backend", choices=["hermes", "mcp"], default="hermes")
    keygen = sub.add_parser(
        "keygen", help="Create a new dedicated EVM key, displaying only its address"
    )
    keygen.add_argument("--output", type=Path, required=True)
    for command in [
        "serve",
        "wallet",
        "call",
        "probe",
        "tools",
        "status",
        "reconcile",
        "hermes-config",
        "doctor",
    ]:
        item = sub.add_parser(command)
        item.add_argument("--config", type=Path, required=True)
        if command in ("call", "probe", "tools"):
            item.add_argument("--peer", required=True)
        if command in ("call", "probe"):
            item.add_argument("--tool", required=True)
            item.add_argument("--arguments", default="{}", help="JSON object")
        if command == "call":
            item.add_argument(
                "--request-id", required=True, help="Stable ID; reuse for the same request"
            )
        if command in ("status", "reconcile"):
            item.add_argument("--operation-id", required=command == "reconcile")
        if command == "doctor":
            item.add_argument("--online", action="store_true", help="Also read RPC chain ID")
    return root


async def read_or_call(args: argparse.Namespace) -> dict | list:
    from x402 import x402Client
    from x402.mcp.client import x402MCPSession

    from .transport import connect
    from .wallet import WalletService

    config = load_config(args.config)
    if args.command == "doctor":
        if config.seller and config.seller.backend.kind == "hermes":
            from .backend import AgentBackend

            AgentBackend(config.seller.backend, config.timeout_seconds).check_configuration()
            AgentBackend.check_hermes()
        if args.online:
            await Chain(config).check_network()
        return {
            "valid": True,
            "network": config.network,
            "rpc_checked": args.online,
            "versions": {name: version(name) for name in ("envar-pay", "x402", "mcp")},
        }
    if args.command in ("status", "reconcile"):
        store = Store(config.state_dir)
        if args.command == "status":
            return store.public_status(args.operation_id)
        row = store.get(args.operation_id)
        if not row or not row["data"].get("transaction") or not row["data"].get("payload"):
            raise PaymentError(
                "No recorded transaction to reconcile; this command never resubmits payment"
            )
        return await Chain(config).prove(
            row["data"]["transaction"], row["data"]["payload"]["payload"]["authorization"]
        )
    service = WalletService(config)
    if args.command == "tools":
        return await service.list_tools(args.peer)
    arguments = json.loads(args.arguments)
    if not isinstance(arguments, dict):
        raise PaymentError("--arguments must be a JSON object")
    if args.command == "call":
        return await service.call(args.peer, args.tool, arguments, args.request_id)
    peer = service.peer(args.peer, args.tool)
    async with connect(peer, config.timeout_seconds) as session:
        result = await x402MCPSession(session, x402Client(), auto_payment=False).call_tool(
            args.tool, arguments
        )
    return {
        "payment_made": False,
        "result": result.raw_result.model_dump(mode="json", by_alias=True),
    }


def main() -> None:
    logger.remove()
    logger.add(sys.stderr, level="WARNING", format="{level}: {message}")
    args = parser().parse_args()
    try:
        if args.command == "init":
            result = initialize(args.directory, args.pay_to, args.backend)
        elif args.command == "keygen":
            account = Account.create()
            write_new(args.output.expanduser(), account.key.hex() + "\n")
            result = {
                "address": account.address,
                "key_file": str(args.output),
                "private_key_printed": False,
            }
        elif args.command == "hermes-config":
            load_config(args.config)
            result = {
                "mcp_servers": {
                    "payments": {
                        "command": sys.executable,
                        "args": [
                            "-m",
                            "envar_pay",
                            "wallet",
                            "--config",
                            str(args.config.expanduser().resolve()),
                        ],
                        "timeout": 600,
                        "connect_timeout": 30,
                    }
                }
            }
        elif args.command == "wallet":
            from .wallet import WalletService, wallet_mcp

            wallet_mcp(WalletService(load_config(args.config))).run(transport="stdio")
            return
        elif args.command == "serve":
            import uvicorn

            from .seller import PaidServer

            service = PaidServer(load_config(args.config))
            uvicorn.run(
                service.app(),
                host=service.policy.host,
                port=service.policy.port,
                log_level="warning",
            )
            return
        else:
            result = asyncio.run(read_or_call(args))
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except (PaymentError, FileExistsError, FileNotFoundError) as error:
        print(f"envar-pay: {error}", file=sys.stderr)
        raise SystemExit(1) from None
    except ValidationError as error:
        print(
            "envar-pay: invalid configuration: "
            + "; ".join(
                f"{'.'.join(map(str, e['loc']))}: {e['msg']}"
                for e in error.errors(include_input=False)
            ),
            file=sys.stderr,
        )
        raise SystemExit(1) from None
    except Exception as error:
        print(f"envar-pay: {type(error).__name__}; operation did not complete", file=sys.stderr)
        raise SystemExit(1) from None
