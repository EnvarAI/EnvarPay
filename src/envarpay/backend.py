"""Thin adapters to existing Agent services. No Agent is instantiated here."""

from __future__ import annotations

from mcp.types import CallToolResult, Tool

from .config import Backend
from .storage import PaymentError
from .transport import connect


class AgentBackend:
    def __init__(self, config: Backend, timeout: int):
        self.config, self.timeout = config, timeout

    async def list_tools(self) -> list[Tool]:
        if self.config.kind == "http":
            from .runtime_http import RuntimeHTTP

            RuntimeHTTP(self.config, self.timeout).credential()
            return [
                Tool(
                    name="ask_agent",
                    description="Ask the connected agent to perform a single task",
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "question": {"type": "string", "minLength": 1, "maxLength": 32000}
                        },
                        "required": ["question"],
                        "additionalProperties": False,
                    },
                )
            ]
        async with connect(self.config.upstream, self.timeout) as session:
            tools, cursor = [], None
            for _ in range(4):
                page = await session.list_tools(cursor=cursor)
                tools.extend(page.tools)
                if len(tools) > 64:
                    raise PaymentError("Expose at most 64 selected capabilities")
                cursor = page.nextCursor
                if not cursor:
                    return tools
            raise PaymentError("Capability discovery exceeded the page limit")

    async def call(self, name: str, arguments: dict) -> CallToolResult:
        if self.config.kind == "mcp":
            async with connect(self.config.upstream, self.timeout) as session:
                return await session.call_tool(name, arguments)
        from .runtime_http import RuntimeHTTP

        if name != "ask_agent":
            raise PaymentError("Unknown Agent capability")
        return await RuntimeHTTP(self.config, self.timeout).call(arguments["question"])
