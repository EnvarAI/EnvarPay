"""Exercise the real MCP transport and its private/public access boundary."""

import uuid
from unittest.mock import AsyncMock

from mcp.types import CallToolResult, TextContent, Tool
from starlette.testclient import TestClient

from envarpay.config import Config
from envarpay.service import AgentService


def test_private_service_requires_auth_and_ownership_proof_contains_no_secret(tmp_path):
    token = tmp_path / "access-token"
    token.write_text("private-service-token-" * 3)
    token.chmod(0o600)
    agent_id = str(uuid.uuid4())
    config = Config.model_validate(
        {
            "service": {
                "bearer_token_file": str(token),
                "allowed_hosts": ["testserver"],
                "tools": ["ask_agent"],
                "backend": {"kind": "mcp", "upstream": {"url": "http://localhost:8000/mcp"}},
            },
            "registration": {"agent_id": agent_id, "challenge": "ownership-challenge-123456"},
        }
    )
    service = AgentService(config)
    service.backend.list_tools = AsyncMock(
        return_value=[
            Tool(
                name="ask_agent",
                inputSchema={
                    "type": "object",
                    "properties": {"question": {"type": "string"}},
                    "required": ["question"],
                },
            )
        ]
    )
    service.backend.call = AsyncMock(
        return_value=CallToolResult(
            content=[TextContent(type="text", text="Existing agent result")]
        )
    )
    with TestClient(service.app()) as client:
        assert client.post("/mcp", json={}).status_code == 401
        assert client.get("/sse").status_code == 401
        proof = client.get(f"/.well-known/envar/{agent_id}")
        assert proof.status_code == 200 and proof.json() == config.registration.model_dump()
        assert token.read_text() not in proof.text
        assert client.get("/.well-known/envar/other-agent").status_code == 404
        headers = {
            "Authorization": f"Bearer {token.read_text()}",
            "Accept": "application/json, text/event-stream",
        }
        response = client.post(
            "/mcp",
            headers=headers,
            json={
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-11-25",
                    "capabilities": {},
                    "clientInfo": {"name": "test", "version": "1"},
                },
            },
        )
        assert response.status_code == 200
        listed = client.post(
            "/mcp",
            headers=headers,
            json={"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
        )
        assert [t["name"] for t in listed.json()["result"]["tools"]] == ["ask_agent"]
        service.backend.call.assert_not_called()
        result = client.post(
            "/mcp",
            headers=headers,
            json={
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": {
                    "name": "ask_agent",
                    "arguments": {"question": "Hello"},
                },
            },
        )
        assert result.json()["result"]["content"][0]["text"] == "Existing agent result"
        service.backend.call.assert_awaited_once_with("ask_agent", {"question": "Hello"})


def test_read_only_import_does_not_load_signers():
    import subprocess
    import sys

    subprocess.run(
        [
            sys.executable,
            "-c",
            "import sys; import envarpay.config; from envarpay.chain import verify_usdc_receipt; "
            'assert "web3" not in sys.modules; assert "envarpay.wallet" not in sys.modules',
        ],
        check=True,
    )
