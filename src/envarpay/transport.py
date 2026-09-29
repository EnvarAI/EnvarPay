"""Official MCP transports shared by upstream forwarding and wallet calls."""

from __future__ import annotations

import os
from collections.abc import AsyncIterator
from contextlib import AsyncExitStack, asynccontextmanager
from datetime import timedelta

import httpx
from mcp import ClientSession, StdioServerParameters
from mcp.client.sse import sse_client
from mcp.client.stdio import stdio_client
from mcp.client.streamable_http import streamable_http_client

from .config import Endpoint
from .storage import PaymentError


def http_client(headers=None, timeout=None, auth=None):
    # In particular, a user's localhost service must never be sent through an inherited proxy.
    return httpx.AsyncClient(
        headers=headers, timeout=timeout or 180, auth=auth, trust_env=False, follow_redirects=False
    )


@asynccontextmanager
async def connect(endpoint: Endpoint, timeout: int = 180) -> AsyncIterator[ClientSession]:
    headers = {}
    if endpoint.bearer_token_env:
        token = os.environ.get(endpoint.bearer_token_env)
        if not token or any(c in token for c in "\r\n"):
            raise PaymentError("Configured bearer-token environment variable is missing or invalid")
        headers["Authorization"] = "Bearer " + token
    async with AsyncExitStack() as stack:
        if endpoint.transport == "stdio":
            params = StdioServerParameters(
                command=endpoint.command,
                args=endpoint.args,
                env={key: os.environ[key] for key in endpoint.env if key in os.environ},
            )
            manager = stdio_client(params)
        elif endpoint.transport == "sse":
            url = endpoint.url if endpoint.url.endswith("/sse") else endpoint.url + "/sse"
            manager = sse_client(
                url, headers=headers, sse_read_timeout=timeout, httpx_client_factory=http_client
            )
        else:
            client = await stack.enter_async_context(http_client(headers=headers, timeout=timeout))
            manager = streamable_http_client(endpoint.url, http_client=client)
        streams = await stack.enter_async_context(manager)
        async with ClientSession(
            streams[0], streams[1], read_timeout_seconds=timedelta(seconds=timeout)
        ) as session:
            await session.initialize()
            yield session
