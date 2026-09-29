"""Bounded, one-shot calls to an operator-configured agent HTTP service."""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path

import httpx
from mcp.types import CallToolResult, TextContent

from .config import Backend
from .storage import PaymentError, secret_file


class RuntimeHTTP:
    """Called only behind PaidServer's confirmed-receipt gate; never retries."""

    def __init__(self, config: Backend, timeout: int):
        self.config, self.timeout = config, timeout

    def credential(self) -> str:
        cfg = self.config
        value = (
            secret_file(Path(cfg.api_key_file))
            if cfg.api_key_file
            else os.environ.get(cfg.api_key_env or "", "")
        )
        if not value or any(c in value for c in "\r\n"):
            raise PaymentError("Configured runtime credential is missing or invalid")
        return value

    async def call(self, question: str) -> CallToolResult:
        cfg = self.config
        if not isinstance(question, str) or not question.strip() or len(question) > 32000:
            raise PaymentError("Question must contain 1–32000 characters")
        if cfg.http_api == "responses":
            path = "responses"
            body = {"model": cfg.model, "input": question, "stream": False}
        else:
            path = "chat/completions"
            body = {
                "model": cfg.model,
                "messages": [{"role": "user", "content": question}],
                "stream": False,
            }
        # No buyer-controlled URL, headers, agent ID, model override or session ID.
        # No redirects, retries, proxy inheritance or SDK retries on paid work.
        headers = {"Authorization": f"Bearer {self.credential()}"}
        try:
            async with asyncio.timeout(self.timeout):
                async with httpx.AsyncClient(
                    timeout=self.timeout, follow_redirects=False, trust_env=False
                ) as client:
                    async with client.stream(
                        "POST", f"{cfg.base_url}/{path}", json=body, headers=headers
                    ) as response:
                        if response.status_code != 200:
                            raise PaymentError(
                                f"Agent runtime returned HTTP {response.status_code}; "
                                "inspect the original operation before any retry"
                            )
                        data = bytearray()
                        async for chunk in response.aiter_bytes(chunk_size=65536):
                            data.extend(chunk)
                            if len(data) > cfg.max_response_bytes:
                                raise PaymentError(
                                    "Agent runtime response exceeded configured limit"
                                )
            value = json.loads(data)
        except (httpx.HTTPError, TimeoutError, ValueError):
            # Do not echo operator credentials, URLs or upstream error bodies.
            raise PaymentError(
                "Agent runtime result is unresolved; inspect the original operation, do not retry"
            ) from None
        answer = terminal_text(value, cfg.http_api)
        return CallToolResult(content=[TextContent(type="text", text=answer)])


def terminal_text(value: object, api: str) -> str:
    """Refuse partial, failed or client-tool-dependent results as paid delivery."""
    invalid = PaymentError("Agent runtime did not return a completed text answer")
    if not isinstance(value, dict) or value.get("error"):
        raise invalid
    if api == "chat-completions":
        choices = value.get("choices")
        if not isinstance(choices, list) or len(choices) != 1:
            raise invalid
        choice = choices[0]
        if not isinstance(choice, dict) or choice.get("finish_reason") != "stop":
            raise invalid
        message = choice.get("message")
        if (
            not isinstance(message, dict)
            or message.get("role") != "assistant"
            or message.get("tool_calls")
            or message.get("function_call")
            or message.get("refusal")
        ):
            raise invalid
        answer = message.get("content")
        if not isinstance(answer, str) or not answer.strip():
            raise invalid
        return answer
    if value.get("status") != "completed" or value.get("incomplete_details"):
        raise invalid
    output = value.get("output")
    if not isinstance(output, list):
        raise invalid
    completed_tools = {
        item.get("call_id")
        for item in output
        if isinstance(item, dict)
        and item.get("type") == "function_call_output"
        and item.get("status") == "completed"
        and isinstance(item.get("call_id"), str)
    }
    texts = []
    for item in output:
        if not isinstance(item, dict):
            raise invalid
        kind = item.get("type")
        if item.get("status") not in (None, "completed"):
            raise invalid
        if kind in ("function_call", "function_call_output"):
            # Hermes replays completed server-side tools; pending client calls are not delivery.
            if item.get("status") != "completed":
                raise invalid
            if kind == "function_call" and item.get("call_id") not in completed_tools:
                raise invalid
            continue
        if kind == "reasoning":
            continue
        if kind != "message" or item.get("role") != "assistant":
            raise invalid
        if item.get("phase") == "commentary":
            continue
        content = item.get("content")
        if not isinstance(content, list):
            raise invalid
        for part in content:
            if not isinstance(part, dict) or part.get("type") != "output_text":
                raise invalid
            text = part.get("text")
            if not isinstance(text, str):
                raise invalid
            texts.append(text)
    answer = "\n".join(texts)
    if not answer.strip():
        raise invalid
    return answer
