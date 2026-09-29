"""Test doubles are offline protocol tests, never real-payment evidence."""

import copy
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from eth_account import Account
from mcp.types import CallToolResult, TextContent, Tool

from envar_pay.config import Config
from envar_pay.seller import PaidServer

PAYEE = "0xaCf233534e258177f6dc704e6251294D96638ACC"
TX = "0x" + "11" * 32


@pytest.fixture
def config(tmp_path: Path) -> Config:
    key = tmp_path / "buyer.key"
    key.write_text(Account.create().key.hex())
    key.chmod(0o600)
    return Config.model_validate(
        {
            "state_dir": str(tmp_path / "wallet"),
            "wallet": {
                "key_file": str(key),
                "payments_enabled": True,
                "peers": {
                    "seller": {
                        "url": "http://localhost:4020/mcp",
                        "pay_to": PAYEE,
                        "tools": ["ask_agent"],
                    }
                },
            },
        }
    )


@pytest.fixture
async def paid_server(config: Config, tmp_path: Path, respx_mock):
    supported = {
        "kinds": [{"x402Version": 2, "scheme": "exact", "network": config.network}],
        "extensions": [],
        "signers": {},
    }
    respx_mock.get("https://x402.org/facilitator/supported").respond(200, json=supported)
    verify = respx_mock.post("https://x402.org/facilitator/verify").respond(
        200, json={"isValid": True}
    )
    settle = respx_mock.post("https://x402.org/facilitator/settle").respond(
        200,
        json={
            "success": True,
            "transaction": TX,
            "network": config.network,
        },
    )
    seller_config = Config.model_validate(
        {
            "state_dir": str(tmp_path / "seller"),
            "seller": {
                "pay_to": PAYEE,
                "backend": {"kind": "mcp", "upstream": {"url": "http://localhost:8000/mcp"}},
                "tools": {"ask_agent": {"amount_atomic": 10000}},
            },
        }
    )
    server = PaidServer(seller_config)
    server.chain.check_network = AsyncMock()
    server.chain.prove = AsyncMock(return_value={"transaction": TX})
    server.backend.list_tools = AsyncMock(
        return_value=[
            Tool(
                name="ask_agent",
                inputSchema={
                    "type": "object",
                    "properties": {"question": {"type": "string"}},
                    "required": ["question"],
                    "additionalProperties": False,
                },
            )
        ]
    )
    server.backend.call = AsyncMock(
        return_value=CallToolResult(
            content=[TextContent(type="text", text="test-double answer")],
            structuredContent={"answer": "test-double answer"},
            _meta={"upstream": "preserved"},
        )
    )
    await server.initialize()
    return server, verify, settle


@pytest.fixture
async def quote(paid_server):
    server, _, _ = paid_server
    result = await server.call("ask_agent", {"question": "test"}, {})
    return copy.deepcopy(result.structuredContent)
