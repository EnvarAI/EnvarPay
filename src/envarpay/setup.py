"""Generate a reviewed, role-specific setup without signing or editing host profiles."""

from __future__ import annotations

import json
import os
import re
import secrets
import shlex
import sys
from pathlib import Path

import tomli_w

from .config import Config, address
from .host_config import host_config
from .storage import PaymentError

AGENTS = ("openclaw", "hermes", "opencode", "goose", "langgraph", "pydantic-ai", "mcp")
HOSTS = AGENTS[:4]
GUIDES = "https://github.com/EnvarAI/EnvarPay/blob/main/docs/integrations/"


def atomic_usdc(value: str) -> int:
    """Parse decimal USDC exactly; never round or accept floating-point notation."""
    if not re.fullmatch(r"[0-9]+(?:\.[0-9]{1,6})?", value):
        raise PaymentError("Use a positive USDC amount with at most 6 decimals, e.g. 0.01")
    whole, _, fraction = value.partition(".")
    amount = int(whole) * 1_000_000 + int(fraction.ljust(6, "0"))
    if not 1 <= amount <= 10**12:
        raise PaymentError("USDC amount must be between 0.000001 and 1000000")
    return amount


def usdc(amount: int) -> str:
    whole, fraction = divmod(amount, 1_000_000)
    return f"{whole}.{fraction:06d}".rstrip("0").rstrip(".")


def write_new(path: Path, text: str) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as file:
        file.write(text)


def initialize(
    directory: Path,
    pay_to: str | None,
    backend: str = "mcp",
    mode: str = "seller",
    *,
    agent: str = "mcp",
    role: str | None = None,
    upstream: str = "http://127.0.0.1:8000/mcp",
    peer_url: str = "http://127.0.0.1:4020/mcp",
    peer_pay_to: str | None = None,
    tool: str = "ask_agent",
    price: str = "0.01",
    max_per_call: str = "0.01",
    budget: str = "0.01",
    allow_http: bool = False,
) -> dict:
    if agent not in AGENTS or role not in (None, "buyer", "seller", "both"):
        raise PaymentError("Choose a supported agent and buyer, seller or both")
    if mode not in ("seller", "private"):
        raise PaymentError("Choose seller or private mode")
    if mode == "private" and (role is not None or pay_to or peer_pay_to):
        raise PaymentError("Private mode has no payment role or receiving wallet")
    role = role or "both"
    if backend not in ("mcp", "openclaw", "hermes-http"):
        raise PaymentError("Unknown seller backend")
    if backend != "mcp" and (upstream != "http://127.0.0.1:8000/mcp" or tool != "ask_agent"):
        raise PaymentError("--upstream and custom --tool require the MCP backend")
    if not re.fullmatch(r"[A-Za-z0-9_.-]{1,128}", tool):
        raise PaymentError("Tool name must be 1-128 letters, digits, underscores, dots or hyphens")
    seller_backend: dict = {
        "kind": "mcp",
        "upstream": {"transport": "streamable-http", "url": upstream, "allow_http": allow_http},
    }
    if backend in ("openclaw", "hermes-http"):
        seller_backend = {
            "kind": "http",
            "http_api": "responses",
            "base_url": "http://127.0.0.1:18789/v1"
            if backend == "openclaw"
            else "http://127.0.0.1:8642/v1",
            "model": "openclaw/seller" if backend == "openclaw" else "hermes-agent",
            "api_key_env": "ENVARPAY_RUNTIME_TOKEN",
        }
    if mode == "private":
        return _private_setup(directory, agent, seller_backend, tool)
    if not pay_to:
        raise PaymentError("Payment setup requires --pay-to; private mode does not need a wallet")
    try:
        pay_to = address(pay_to)
        recipient = address(peer_pay_to) if peer_pay_to else pay_to
    except ValueError as error:
        raise PaymentError(str(error)) from None
    if role != "both" and peer_pay_to:
        raise PaymentError("--peer-pay-to is for --role both; otherwise use --pay-to")
    # A both-role local example can buy from itself. A remote peer must be explicit.
    if role == "both" and peer_url != "http://127.0.0.1:4020/mcp" and not peer_pay_to:
        raise PaymentError("For --role both with another seller, supply --peer-pay-to")
    cost, per_call, total = map(atomic_usdc, (price, max_per_call, budget))
    if per_call > total:
        raise PaymentError("--max-per-call cannot exceed --budget")
    common = {
        "schema_version": 1,
        "network": "eip155:84532",
        "rpc_url": "https://sepolia.base.org",
    }
    seller = common | {
        "state_dir": "./seller-state",
        "seller": {
            "pay_to": pay_to,
            "host": "127.0.0.1",
            "port": 4020,
            "tools": {tool: {"amount_atomic": cost}},
            "backend": seller_backend,
        },
    }
    buyer = common | {
        "state_dir": "./buyer-state",
        "wallet": {
            "key_file": "./buyer.key",
            "payments_enabled": False,
            "max_per_call_atomic": per_call,
            "max_total_atomic": total,
            "peers": {
                "seller": {
                    "transport": "streamable-http",
                    "url": peer_url,
                    "pay_to": recipient,
                    "tools": [tool],
                    "allow_http": allow_http,
                }
            },
        },
    }
    configs = {}
    if role in ("seller", "both"):
        configs["seller.toml"] = seller
    if role in ("buyer", "both"):
        configs["buyer.toml"] = buyer
    # Validate everything before creating any files, including URLs and recipients.
    for value in configs.values():
        Config.model_validate(value)
    directory = _new_directory(directory)
    for name, value in configs.items():
        comment = "# Base Sepolia test USDC. 1 USDC = 1000000 atomic units.\n"
        if name == "buyer.toml":
            comment += (
                "# Review peer, recipient and limits before changing payments_enabled.\n"
                "# Budget is cumulative for this state directory; restarting does not reset it.\n"
            )
        else:
            comment += "# Keep the raw upstream private. Only this payment gate should be public.\n"
        write_new(directory / name, comment + tomli_w.dumps(value))
    files = list(configs)
    if "buyer.toml" in configs:
        command = {
            "command": sys.executable,
            "args": ["-m", "envarpay", "wallet", "--config", str(directory / "buyer.toml")],
        }
        write_new(directory / "wallet-command.json", json.dumps(command, indent=2) + "\n")
        files.append("wallet-command.json")
        if agent in HOSTS:
            write_new(
                directory / "host-config.json",
                json.dumps(host_config(agent, directory / "buyer.toml"), indent=2) + "\n",
            )
            files.append("host-config.json")
    guide = GUIDES + (agent + ".md" if agent != "mcp" else "index.md")

    def q(filename: str) -> str:
        return shlex.quote(str(directory / filename))

    steps = []
    if "buyer.toml" in configs:
        steps.extend(
            [
                "Create a dedicated test wallet: envarpay keygen --output " + q("buyer.key"),
                f"Fund only on Base Sepolia; review {recipient}, tool {tool}, "
                f"{usdc(per_call)} USDC/call and {usdc(total)} USDC total in buyer.toml.",
                "Set payments_enabled = true only after that review.",
                "Merge host-config.json into your agent's configuration and reload it."
                if agent in HOSTS
                else "Use wallet-command.json with the MCP adapter in your guide.",
                "Check without paying: envarpay doctor --config " + q("buyer.toml"),
            ]
        )
    if "seller.toml" in configs:
        steps.extend(
            [
                "Start your private runtime/MCP tool using the agent guide; review seller.toml.",
                "Check configuration: envarpay doctor --config " + q("seller.toml"),
                "Start receiving: envarpay serve --config " + q("seller.toml"),
            ]
        )
    result = {
        "directory": str(directory),
        "agent": agent,
        "role": role,
        "network": "Base Sepolia (eip155:84532)",
        "payments_enabled": False,
        "seller": {
            "recipient": pay_to,
            "tool": tool,
            "price_usdc": usdc(cost),
            "backend": seller_backend["kind"],
            "upstream": upstream if backend == "mcp" else seller_backend["base_url"],
        }
        if "seller.toml" in configs
        else None,
        "buyer": {
            "peer_url": peer_url,
            "recipient": recipient,
            "tool": tool,
            "max_per_call_usdc": usdc(per_call),
            "budget_usdc": usdc(total),
        }
        if "buyer.toml" in configs
        else None,
        "files": files + ["SETUP.md"],
        "guide": guide,
        "next_steps": steps,
    }
    write_new(directory / "SETUP.md", _instructions(result))
    return result


def _new_directory(directory: Path) -> Path:
    directory = directory.expanduser()
    if directory.is_symlink():
        raise PaymentError("Initialization directory cannot be a symbolic link")
    directory = directory.resolve()
    directory.mkdir(parents=True, mode=0o700, exist_ok=True)
    if any(directory.iterdir()):
        raise PaymentError("Initialization requires an empty directory; nothing was overwritten")
    write_new(directory / ".gitignore", "*.key\nservice.token\n*-state/\n*.sqlite3*\n.env*\n")
    return directory


def _private_setup(directory: Path, agent: str, backend: dict, tool: str) -> dict:
    config = {
        "schema_version": 1,
        "state_dir": "./agent-state",
        "service": {
            "host": "127.0.0.1",
            "port": 4020,
            "bearer_token_file": "./service.token",
            "tools": [tool],
            "backend": backend,
        },
    }
    Config.model_validate(config)
    directory = _new_directory(directory)
    write_new(directory / "service.token", secrets.token_urlsafe(32) + "\n")
    write_new(directory / "agent.toml", tomli_w.dumps(config))
    path = shlex.quote(str(directory / "agent.toml"))
    result = {
        "directory": str(directory),
        "agent": agent,
        "role": "private",
        "network": "Not used (private authenticated service)",
        "payments_enabled": False,
        "config": str(directory / "agent.toml"),
        "token_file": str(directory / "service.token"),
        "buyer": None,
        "seller": None,
        "files": ["agent.toml", "service.token", "SETUP.md"],
        "guide": GUIDES + (agent + ".md" if agent != "mcp" else "index.md"),
        "next_steps": [
            "Configure the existing runtime endpoint and runtime access credential in agent.toml.",
            "Inspect configuration: envarpay doctor --config " + path,
            "Start the authenticated entry: envarpay serve --config " + path,
            "Use service.token as the private MCP access credential; never publish its contents.",
        ],
    }
    write_new(directory / "SETUP.md", _instructions(result))
    return result


def describe_config(config: Config) -> dict:
    result = {
        "network": config.network,
        "chain_id": config.chain_id,
        "usdc_contract": config.asset,
        "state_dir": config.state_dir,
    }
    if config.wallet:
        wallet = config.wallet
        result["buyer"] = {
            "payments_enabled": wallet.payments_enabled,
            "key_file_present": Path(wallet.key_file).is_file(),
            "max_per_call_usdc": usdc(wallet.max_per_call_atomic),
            "budget_usdc": usdc(wallet.max_total_atomic),
            "peers": {
                name: {"url": peer.url, "recipient": peer.pay_to, "tools": peer.tools}
                for name, peer in wallet.peers.items()
            },
        }
    if config.seller:
        seller = config.seller
        result["seller"] = {
            "recipient": seller.pay_to,
            "listen": f"{seller.host}:{seller.port}",
            "backend": seller.backend.kind,
            "upstream": seller.backend.upstream.url
            if seller.backend.upstream
            else seller.backend.base_url,
            "tools_usdc": {name: usdc(price.amount_atomic) for name, price in seller.tools.items()},
        }
    if config.service:
        result["private_service"] = {
            "listen": f"{config.service.host}:{config.service.port}",
            "backend": config.service.backend.kind,
            "tools": config.service.tools,
            "authentication_required": True,
        }
    return result


def _instructions(result: dict) -> str:
    lines = [
        f"# EnvarPay · {result['agent']} · {result['role']}",
        "",
        f"Network: **{result['network']}**. Buyer payments are **OFF**.",
        "",
        "| File | Use |",
        "|---|---|",
    ]
    descriptions = {
        "agent.toml": "Authenticated entry to an existing private service (no payment wallet)",
        "service.token": "Owner-only MCP access token; never commit or publish it",
        "buyer.toml": "Allowed seller, receiving address and persistent spending limits",
        "seller.toml": "Your receiving address, tool price and private runtime endpoint",
        "host-config.json": "Merge this entry into your existing agent configuration",
        "wallet-command.json": "Launch parameters for any native MCP client",
    }
    lines.extend(f"| `{f}` | {descriptions[f]} |" for f in result["files"] if f in descriptions)
    for role in ("buyer", "seller"):
        if result[role]:
            lines.extend(
                [
                    "",
                    f"## {role.title()} policy",
                    "",
                    "```json",
                    json.dumps(result[role], indent=2),
                    "```",
                ]
            )
    lines.extend(["", "## Next steps", ""])
    lines.extend(f"{i}. {step}" for i, step in enumerate(result["next_steps"], 1))
    lines.extend(
        [
            "",
            f"Full agent guide: {result['guide']}",
            "",
            "This setup never starts your agent, creates a wallet key or makes a payment.",
            "For the same purchase, reuse its request ID. Preserve the ledger and original",
            "authorization on uncertainty; never reset state or replace a signature to retry.",
            "",
        ]
    )
    return "\n".join(lines)
