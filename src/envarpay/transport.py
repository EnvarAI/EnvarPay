"""Official MCP transports shared by upstream forwarding and wallet calls."""

from __future__ import annotations

import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import timedelta

from mcp import ClientSession, StdioServerParameters
from mcp.client.sse import sse_client
from mcp.client.stdio import stdio_client
from mcp.client.streamable_http import streamablehttp_client

from .config import Endpoint
from .storage import PaymentError


@asynccontextmanager
async def connect(endpoint: Endpoint, timeout: int = 180) -> AsyncIterator[ClientSession]:
    headers = {}
    if endpoint.bearer_token_env:
        token = os.environ.get(endpoint.bearer_token_env)
        if not token:
            raise PaymentError("Configured bearer-token environment variable is missing")
        headers["Authorization"] = "Bearer " + token
    if endpoint.transport == "stdio":
        params = StdioServerParameters(
            command=endpoint.command,
            args=endpoint.args,
            env={key: os.environ[key] for key in endpoint.env if key in os.environ},
        )
        manager = stdio_client(params)
    elif endpoint.transport == "sse":
        url = endpoint.url if endpoint.url.endswith("/sse") else endpoint.url + "/sse"
        manager = sse_client(url, headers=headers, sse_read_timeout=timeout)
    else:
        manager = streamablehttp_client(endpoint.url, headers=headers, sse_read_timeout=timeout)
    async with manager as streams:
        async with ClientSession(
            streams[0], streams[1], read_timeout_seconds=timedelta(seconds=timeout)
        ) as session:
            await session.initialize()
            yield session
