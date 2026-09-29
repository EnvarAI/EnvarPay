"""Check the installed wheel in an official Hermes runtime, without paying or model calls."""

import asyncio
import json
import os
import subprocess
import sys
from importlib.metadata import version
from pathlib import Path

from envarpay.backend import AgentBackend
from envarpay.cli import initialize
from envarpay.config import load_config

root = Path(os.environ["HERMES_HOME"])
root.mkdir(mode=0o700, parents=True, exist_ok=True)
(root / "config.yaml").write_text("tools:\n  tool_search:\n    enabled: off\n")
initialize(root / "payments", "0x" + "33" * 20, "hermes")
config = root / "payments" / "buyer.toml"
snippet = json.loads(
    subprocess.check_output(
        [
            sys.executable,
            "-m",
            "envarpay",
            "hermes-config",
            "--config",
            str(config),
        ],
        text=True,
    )
)
from tools.mcp_tool import register_mcp_servers  # noqa: E402

tools = register_mcp_servers(snippet["mcp_servers"])
if "mcp__payments__call_paid_tool" not in tools:
    raise RuntimeError("Official Hermes did not register the installed wallet MCP")
seller = load_config(root / "payments" / "seller.toml")
seller.seller.backend.model = "installation-check-no-model-call"
seller.seller.backend.base_url = "http://127.0.0.1:9/v1"
seller.seller.backend.api_key_env = None
backend = AgentBackend(seller.seller.backend, seller.timeout_seconds)
listed = asyncio.run(backend.list_tools())
if [tool.name for tool in listed] != ["ask_agent"]:
    raise RuntimeError("Official Hermes adapter could not expose ask_agent")
print(
    json.dumps(
        {
            "hermes": version("hermes-agent"),
            "envarpay": version("envarpay"),
            "wallet_tools_registered": tools,
            "seller_tools": [tool.name for tool in listed],
            "payment_attempted": False,
            "model_called": False,
        },
        indent=2,
    )
)
