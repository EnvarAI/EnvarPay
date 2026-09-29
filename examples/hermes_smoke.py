"""Check the installed wheel in an official Hermes runtime, without paying or model calls."""

import json
import os
import subprocess
import sys
from importlib.metadata import version
from pathlib import Path

from envarpay.cli import initialize

root = Path(os.environ["HERMES_HOME"])
root.mkdir(mode=0o700, parents=True, exist_ok=True)
if (root / "config.yaml").exists():
    raise RuntimeError("Use an isolated empty HERMES_HOME for this smoke test")
(root / "config.yaml").write_text("tools:\n  tool_search:\n    enabled: off\n")
initialize(root / "payments", "0x" + "33" * 20, "mcp")
config = root / "payments" / "buyer.toml"
snippet = json.loads(
    subprocess.check_output(
        [
            sys.executable,
            "-m",
            "envarpay",
            "host-config",
            "--host",
            "hermes",
            "--config",
            str(config),
        ],
        text=True,
    )
)
from tools.mcp_tool import register_mcp_servers  # noqa: E402

tools = register_mcp_servers(snippet["mcp_servers"])
if not any(name.endswith("call_paid_tool") for name in tools):
    raise RuntimeError("Official Hermes did not register the installed wallet MCP")
print(
    json.dumps(
        {
            "hermes": version("hermes-agent"),
            "envarpay": version("envarpay"),
            "wallet_tools_registered": tools,
            "payment_attempted": False,
            "model_called": False,
        },
        indent=2,
    )
)
