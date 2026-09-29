"""Command-line setup, serving and read-only diagnostics."""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from importlib.metadata import version
from pathlib import Path

from eth_account import Account
from loguru import logger
from pydantic import ValidationError

from . import __version__
from .chain import Chain
from .config import load_config
from .setup import AGENTS, describe_config, initialize, write_new
from .storage import PaymentError, Store


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(prog="envarpay", description="MCP + x402 agent payments")
    root.add_argument("--version", action="version", version=__version__)
    sub = root.add_subparsers(dest="command", required=True)
    init = sub.add_parser(
        "init", help="Choose an agent and role; generate configs, wallet entry and setup guide"
    )
    init.add_argument(
        "--directory", type=Path, default=Path("agent-pay"), help="New empty setup directory"
    )
    init.add_argument(
        "--agent", choices=AGENTS, default="mcp", help="Your existing agent/framework"
    )
    init.add_argument(
        "--role", choices=["buyer", "seller", "both"], help="Paid setup role (default: both)"
    )
    init.add_argument(
        "--mode",
        choices=["seller", "private"],
        default="seller",
        help="Private mode connects an authenticated service without payments",
    )
    init.add_argument(
        "--pay-to",
        help="Full receiving address: yours for seller/both, the seller's for buyer",
    )
    init.add_argument("--peer-pay-to", help="Other seller's full address when using --role both")
    init.add_argument(
        "--peer-url", default="http://127.0.0.1:4020/mcp", help="Paid seller MCP endpoint"
    )
    init.add_argument(
        "--upstream", default="http://127.0.0.1:8000/mcp", help="Private MCP capability to sell"
    )
    init.add_argument("--tool", default="ask_agent", help="MCP tool to sell/allow")
    amounts = init.add_argument_group("amounts in USDC (up to six decimals)")
    amounts.add_argument(
        "--price", default="0.01", help="Seller price per tool call (default: 0.01)"
    )
    amounts.add_argument(
        "--max-per-call", default="0.01", help="Buyer per-call limit (default: 0.01)"
    )
    amounts.add_argument(
        "--budget", default="0.01", help="Buyer cumulative limit, not daily (default: 0.01)"
    )
    init.add_argument(
        "--allow-http",
        action="store_true",
        help="Allow remote plain HTTP for private container networks",
    )
    init.add_argument("--json", action="store_true", help="Print the setup summary as JSON")
    init.add_argument(
        "--backend",
        choices=["mcp", "openclaw", "hermes-http"],
        default="mcp",
        help="Seller adapter; defaults to private MCP. HTTP presets are experimental.",
    )
    keygen = sub.add_parser(
        "keygen", help="Create a new dedicated EVM key, displaying only its address"
    )
    keygen.add_argument("--output", type=Path, required=True)
    for command in [
        "serve",
        "wallet",
        "wallet-serve",
        "sync",
        "recover",
        "call",
        "probe",
        "tools",
        "status",
        "reconcile",
        "host-config",
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
        if command == "recover":
            item.add_argument("--request-id", required=True)
        if command == "sync":
            item.add_argument("--watch", action="store_true")
        if command in ("status", "reconcile"):
            item.add_argument("--operation-id", required=command == "reconcile")
        if command == "host-config":
            item.add_argument(
                "--host", choices=["hermes", "openclaw", "opencode", "goose"], required=True
            )
        if command == "doctor":
            item.add_argument("--online", action="store_true", help="Also read RPC chain ID")
    return root


async def read_or_call(args: argparse.Namespace) -> dict | list:
    from x402 import x402Client
    from x402.mcp.client import x402MCPSession

    from .transport import connect
    from .wallet import WalletService

    config = load_config(args.config)
    if args.command == "sync":
        from .directory import Envar

        if not config.connection:
            raise PaymentError("Configure [connection] before synchronizing reports")
        envar = Envar(config.connection, Store(config.state_dir))
        while True:
            result = await envar.flush()
            if not args.watch:
                return result
            await asyncio.sleep(5)
    if args.command == "recover":
        return await WalletService(config).recover(args.request_id)
    if args.command == "doctor":
        endpoint = config.seller or config.service
        if endpoint and endpoint.backend.kind == "http":
            from .runtime_http import RuntimeHTTP

            RuntimeHTTP(endpoint.backend, config.timeout_seconds).credential()
        if config.service:
            from .service import AgentService

            AgentService(config)
        rpc_checked = bool(args.online and (config.seller or config.wallet))
        if rpc_checked:
            await Chain(config).check_network()
        if args.online and endpoint:
            from .backend import AgentBackend

            await AgentBackend(endpoint.backend, config.timeout_seconds).list_tools()
        return {
            "valid": True,
            **describe_config(config),
            "rpc_checked": rpc_checked,
            "versions": {name: version(name) for name in ("envarpay", "x402", "mcp")},
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
            result = initialize(
                args.directory,
                args.pay_to,
                args.backend,
                mode=args.mode,
                agent=args.agent,
                role=args.role,
                upstream=args.upstream,
                peer_url=args.peer_url,
                peer_pay_to=args.peer_pay_to,
                tool=args.tool,
                price=args.price,
                max_per_call=args.max_per_call,
                budget=args.budget,
                allow_http=args.allow_http,
            )
            if not args.json:
                print(f"EnvarPay · {result['agent']} · {result['role']}")
                print(f"Network: {result['network']} | Buyer payments: OFF")
                if result["buyer"]:
                    buyer = result["buyer"]
                    print(f"\nBuy from: {buyer['peer_url']}")
                    print(f"  Recipient: {buyer['recipient']}")
                    print(f"  Tool: {buyer['tool']}")
                    print(
                        f"  Limit: {buyer['max_per_call_usdc']} USDC/call; "
                        f"{buyer['budget_usdc']} USDC cumulative"
                    )
                if result["seller"]:
                    seller = result["seller"]
                    print(f"\nSell: {seller['tool']} for {seller['price_usdc']} USDC/call")
                    print(f"  Receive at: {seller['recipient']}")
                    print(f"  Private upstream: {seller['upstream']} ({seller['backend']})")
                print("\nCreated in " + result["directory"] + ": " + ", ".join(result["files"]))
                print("\nNext:")
                for index, step in enumerate(result["next_steps"], 1):
                    print(f"  {index}. {step}")
                print("\nGuide: " + result["guide"])
                return
        elif args.command == "keygen":
            account = Account.create()
            write_new(args.output.expanduser(), account.key.hex() + "\n")
            result = {
                "address": account.address,
                "key_file": str(args.output),
                "private_key_printed": False,
            }
        elif args.command == "host-config":
            from .host_config import host_config

            result = host_config(args.host, args.config)
        elif args.command == "wallet":
            from .wallet import WalletService, wallet_mcp

            wallet_mcp(WalletService(load_config(args.config))).run(transport="stdio")
            return
        elif args.command == "wallet-serve":
            import uvicorn

            from .wallet import WalletService, wallet_app

            config = load_config(args.config)
            app = wallet_app(WalletService(config))
            uvicorn.run(
                app,
                host=config.wallet_server.host,
                port=config.wallet_server.port,
                log_level="warning",
            )
            return
        elif args.command == "serve":
            import uvicorn

            from .seller import PaidServer
            from .service import AgentService

            config = load_config(args.config)
            service = PaidServer(config) if config.seller else AgentService(config)
            uvicorn.run(
                service.app(config_path=args.config) if config.seller else service.app(),
                host=service.policy.host,
                port=service.policy.port,
                log_level="warning",
            )
            return
        else:
            result = asyncio.run(read_or_call(args))
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except (PaymentError, FileExistsError, FileNotFoundError) as error:
        print(f"envarpay: {error}", file=sys.stderr)
        raise SystemExit(1) from None
    except ValidationError as error:
        print(
            "envarpay: invalid configuration: "
            + "; ".join(
                f"{'.'.join(map(str, e['loc']))}: {e['msg']}"
                for e in error.errors(include_input=False)
            ),
            file=sys.stderr,
        )
        raise SystemExit(1) from None
    except Exception as error:
        print(f"envarpay: {type(error).__name__}; operation did not complete", file=sys.stderr)
        raise SystemExit(1) from None
