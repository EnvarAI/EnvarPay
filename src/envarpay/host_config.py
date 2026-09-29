"""Generate snippets without changing a host's personal configuration."""

from __future__ import annotations

import sys
from pathlib import Path

from .config import load_config
from .storage import PaymentError


def host_config(host: str, config_path: Path) -> dict:
    config = load_config(config_path)
    if config.wallet is None:
        raise PaymentError("Host configuration requires a wallet configuration")
    command = sys.executable
    args = ["-m", "envarpay", "wallet", "--config", str(config_path.expanduser().resolve())]
    # Allow quote, settlement, confirmations and execution to finish before host timeout.
    seconds = config.timeout_seconds * 4 + 30
    tools = ["list_paid_tools", "call_paid_tool", "payment_status", "recover_payment"]
    if config.connection:
        tools += ["discover_agents", "get_agent"]
    if host == "hermes":
        return {
            "mcp_servers": {
                "envarpay": {
                    "command": command,
                    "args": args,
                    "timeout": seconds,
                    "connect_timeout": 30,
                }
            }
        }
    if host == "openclaw":
        return {
            "mcp": {
                "servers": {
                    "envarpay": {
                        "transport": "stdio",
                        "command": command,
                        "args": args,
                        "enabled": True,
                        "connectionTimeoutMs": 30000,
                        "requestTimeoutMs": seconds * 1000,
                        "toolFilter": {"include": tools},
                    }
                }
            }
        }
    if host == "opencode":
        return {
            "mcp": {
                "envarpay": {
                    "type": "local",
                    "command": [command, *args],
                    "enabled": True,
                    "timeout": seconds * 1000,
                }
            }
        }
    if host == "goose":
        return {
            "extensions": {
                "envarpay": {
                    "enabled": True,
                    "type": "stdio",
                    "name": "envarpay",
                    "cmd": command,
                    "args": args,
                    "timeout": seconds,
                }
            }
        }
    raise PaymentError("Choose hermes, openclaw, opencode or goose")
