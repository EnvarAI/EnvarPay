import asyncio
import socket
import sys
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
import uvicorn
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from x402 import x402Client
from x402.mcp.client import x402MCPSession

from envarpay.cli import initialize
from envarpay.config import Endpoint, load_config
from envarpay.transport import connect


@pytest.mark.parametrize("transport", ["sse", "streamable-http"])
async def test_real_http_mcp_payment_required(config, paid_server, respx_mock, transport):
    seller, _, _ = paid_server
    # Only facilitator HTTP is simulated; MCP uses a real local TCP socket.
    respx_mock.route(host="127.0.0.1").pass_through()
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    server = uvicorn.Server(
        uvicorn.Config(seller.app(), host="127.0.0.1", port=port, log_level="error")
    )
    task = asyncio.create_task(server.serve())
    try:
        for _ in range(100):
            if server.started:
                break
            await asyncio.sleep(0.02)
        assert server.started
        endpoint = Endpoint(
            url=f"http://127.0.0.1:{port}/" + ("mcp" if transport == "streamable-http" else "sse"),
            transport=transport,
        )
        async with connect(endpoint) as session:
            tools = await session.list_tools()
            assert [t.name for t in tools.tools] == ["ask_agent"]
            result = await x402MCPSession(session, x402Client(), auto_payment=False).call_tool(
                "ask_agent", {"question": "unpaid"}
            )
            assert result.is_error and not result.payment_made
            assert result.raw_result.structuredContent["x402Version"] == 2
            assert (
                result.raw_result.structuredContent["accepts"][0]["extra"]["paymentFlow"]
                == "upfront"
            )
        seller.backend.call.assert_not_called()
        from envarpay.wallet import WalletService

        config.wallet.peers["seller"].url = endpoint.url
        config.wallet.peers["seller"].transport = endpoint.transport
        wallet = WalletService(config)
        wallet.chain.check_network = AsyncMock()
        wallet.chain.prove = AsyncMock(return_value={"test_double": True})
        paid = await wallet.call("seller", "ask_agent", {"question": "test"}, "http-call")
        assert paid["payment_made"] and paid["result"]["structuredContent"]["answer"]
        seller.backend.call.assert_awaited_once()
    finally:
        server.should_exit = True
        await asyncio.wait_for(task, 5)


async def test_cli_wallet_is_real_stdio_mcp_without_key(tmp_path: Path):
    initialize(tmp_path / "setup", "0x" + "33" * 20, "mcp")
    config_path = tmp_path / "setup" / "buyer.toml"
    config = load_config(config_path)
    assert not config.wallet.payments_enabled
    params = StdioServerParameters(
        command=sys.executable, args=["-m", "envarpay", "wallet", "--config", str(config_path)]
    )
    async with stdio_client(params) as streams:
        async with ClientSession(*streams) as session:
            await session.initialize()
            tools = await session.list_tools()
            assert {t.name for t in tools.tools} == {
                "list_paid_tools",
                "call_paid_tool",
                "payment_status",
            }
            status = await session.call_tool("payment_status", {"request_id": "not-attempted"})
            assert not status.isError


async def test_mcp_backend_preserves_schema_and_result(tmp_path: Path):
    from envarpay.backend import AgentBackend
    from envarpay.config import Backend

    upstream = tmp_path / "server.py"
    upstream.write_text("""from mcp.server.fastmcp import FastMCP
from mcp.types import CallToolResult, TextContent
mcp = FastMCP("test upstream")
@mcp.tool()
def add(left: int, right: int) -> CallToolResult:
    return CallToolResult(content=[TextContent(type="text", text=str(left+right))],
        structuredContent={"sum":left+right}, _meta={"source":"test-upstream"})
mcp.run(transport="stdio")
""")
    backend = AgentBackend(
        Backend(
            kind="mcp",
            upstream=Endpoint(transport="stdio", command=sys.executable, args=[str(upstream)]),
        ),
        30,
    )
    tools = await backend.list_tools()
    assert (
        tools[0].name == "add" and tools[0].inputSchema["properties"]["left"]["type"] == "integer"
    )
    result = await backend.call("add", {"left": 2, "right": 3})
    assert result.structuredContent == {"sum": 5} and result.meta["source"] == "test-upstream"
