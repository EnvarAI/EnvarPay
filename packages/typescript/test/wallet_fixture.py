"""Real Python wallet MCP adapter, fake execution only; no keys or payments."""

import asyncio
import json
import socket
import sys
from pathlib import Path
from types import SimpleNamespace

import uvicorn

from envarpay.storage import PaymentError
from envarpay.wallet import wallet_app

directory = Path(sys.argv[1])
token_file = directory / "token"
token_file.write_text("test-wallet-token-00000000000000000000")
token_file.chmod(0o600)
settings = SimpleNamespace(bearer_token_file=str(token_file), allowed_hosts=["127.0.0.1:*"])


class Service:
    config = SimpleNamespace(wallet_server=settings)
    envar = None

    def __init__(self):
        self.store = self
        self.rows = {}
        self.results = {}
        self.calls = {}

    async def list_tools(self, peer):
        if peer != "approved":
            raise PaymentError("Unknown peer; configure the operator allowlist first")
        return {"peer": peer, "tools": [{"name": "ask_agent", "inputSchema": {"type": "object"}}]}

    async def call(self, peer, tool, arguments, request_id):
        if tool == "refused":
            raise PaymentError("Payments are disabled")
        self.calls[request_id] = self.calls.get(request_id, 0) + 1
        (directory / "calls.json").write_text(json.dumps(self.calls))
        self.rows[request_id] = {
            "id": "buy:" + request_id,
            "status": "unknown",
            "amount": 0,
            "updated": 1.0,
            "transaction": None,
            "payment_state": "unsigned",
            "execution_state": "not_started",
            "invocation_id": None,
            "report_pending": False,
        }
        if tool == "slow":
            await asyncio.sleep(0.25)
        result = {
            "request_id": request_id,
            "payment_made": False,
            "payment": None,
            "result": {"content": [{"type": "text", "text": json.dumps(arguments)}]},
        }
        self.rows[request_id]["status"] = "completed"
        self.results[request_id] = result
        return result

    def public_status(self, key):
        row = self.rows.get(key.removeprefix("buy:"))
        return [row] if row else []

    async def recover(self, request_id):
        if request_id not in self.results:
            raise PaymentError("Unknown original request")
        return self.results[request_id]


sock = socket.socket()
sock.bind(("127.0.0.1", 0))
print(sock.getsockname()[1], flush=True)
server = uvicorn.Server(uvicorn.Config(wallet_app(Service()), log_level="critical"))
server.run(sockets=[sock])
