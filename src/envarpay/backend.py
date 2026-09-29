"""Adapters for an existing MCP service or an unmodified installed Hermes runtime."""

from __future__ import annotations

import asyncio
import os
import uuid
from pathlib import Path

from mcp.types import CallToolResult, TextContent, Tool

from .config import Backend
from .storage import PaymentError, secret_file
from .transport import connect


class AgentBackend:
    def __init__(self, config: Backend, timeout: int):
        self.config, self.timeout = config, timeout

    async def list_tools(self) -> list[Tool]:
        if self.config.kind in ("hermes", "http"):
            self.check_configuration()
            if self.config.kind == "hermes":
                self.check_hermes()
            return [
                Tool(
                    name="ask_agent",
                    description="Ask this configured agent to perform a task",
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
            while True:
                page = await session.list_tools(cursor=cursor)
                tools.extend(page.tools)
                cursor = page.nextCursor
                if not cursor:
                    return tools

    @staticmethod
    def check_hermes() -> None:
        try:
            from run_agent import AIAgent  # noqa: F401
        except ImportError as error:
            raise PaymentError(
                "Install envarpay into your official Hermes Python environment"
            ) from error

    def check_configuration(self) -> None:
        cfg = self.config
        if cfg.kind == "http":
            from .runtime_http import RuntimeHTTP

            RuntimeHTTP(cfg, self.timeout).credential()
        if cfg.model == "YOUR_MODEL" or "YOUR_MODEL_ENDPOINT" in (cfg.base_url or ""):
            raise PaymentError("Replace the example model and endpoint before serving paid tools")
        if cfg.api_key_env and not os.environ.get(cfg.api_key_env):
            raise PaymentError("Configured model API-key environment variable is missing")
        if cfg.api_key_file:
            secret_file(Path(cfg.api_key_file))

    async def call(self, name: str, arguments: dict) -> CallToolResult:
        if self.config.kind == "mcp":
            async with connect(self.config.upstream, self.timeout) as session:
                return await session.call_tool(name, arguments)
        if self.config.kind == "http":
            from .runtime_http import RuntimeHTTP

            return await RuntimeHTTP(self.config, self.timeout).call(arguments["question"])
        return await asyncio.to_thread(self.hermes_call, arguments["question"])

    def hermes_call(self, question: str) -> CallToolResult:
        from run_agent import AIAgent

        cfg = self.config
        key = secret_file(Path(cfg.api_key_file)) if cfg.api_key_file else None
        if cfg.api_key_env:
            key = os.environ.get(cfg.api_key_env)
            if not key:
                raise PaymentError("Configured model API-key environment variable is missing")
        agent = AIAgent(
            model=cfg.model,
            base_url=cfg.base_url,
            provider=cfg.provider,
            api_key=key,
            enabled_toolsets=cfg.toolsets,
            max_iterations=cfg.max_iterations,
            max_tokens=cfg.max_tokens,
            quiet_mode=True,
            save_trajectories=False,
            skip_context_files=True,
            skip_memory=True,
            load_soul_identity=False,
            session_id=f"envarpay-{uuid.uuid4()}",
        )
        result = agent.run_conversation(question, system_message=cfg.system_prompt)
        answer = result.get("final_response")
        if not answer:
            raise PaymentError(
                "Hermes produced no answer after payment; inspect the saved operation"
            )
        return CallToolResult(content=[TextContent(type="text", text=answer)])
