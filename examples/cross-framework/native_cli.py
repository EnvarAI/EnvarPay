"""Expose a dedicated native OpenCode CLI as MCP; payment remains in EnvarPay."""

import argparse
import asyncio
import hashlib
import json
import os
import signal
import sqlite3
import time
import uuid
from pathlib import Path


def record(event, **values):
    with Path("/evidence/events.jsonl").open("a") as file:
        file.write(json.dumps({"event": event, "at": time.time(), **values}) + "\n")


async def invoke(question, framework="opencode"):
    env = dict(os.environ)
    key = Path("/run/secrets/llm_api_key").read_text().strip()
    env["ENVARPAY_MODEL_API_KEY"] = key
    if framework == "goose":
        env["OPENAI_API_KEY"] = key
    if framework == "opencode":
        command = ["opencode", "--pure", "run", "--format", "json", question]
    elif framework == "hermes":
        command = [
            "/opt/hermes-latest/bin/hermes",
            "chat",
            "--oneshot",
            "--format",
            "stream-json",
            "--max-turns",
            "8",
            "-q",
            question,
        ]
    elif framework == "openclaw":
        command = [
            "/opt/openclaw-runtime/node",
            "/opt/openclaw-runtime/app/openclaw.mjs",
            "agent",
            "--local",
            "--agent",
            env.get("ENVARPAY_AGENT_ROLE", "seller"),
            "--session-id",
            str(uuid.uuid4()),
            "--message",
            question,
            "--json",
            "--timeout",
            "180",
        ]
    else:
        command = [
            "goose",
            "run",
            "--no-session",
            "--output-format",
            "json",
            "--provider",
            "openai",
            "--model",
            env.get("MODEL_NAME", "gpt-4.1-mini"),
            "--text",
            question,
        ]
    process = await asyncio.create_subprocess_exec(
        *command,
        env=env,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        start_new_session=True,
    )
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), 600)
    except (TimeoutError, asyncio.CancelledError):
        os.killpg(process.pid, signal.SIGTERM)
        await process.wait()
        raise RuntimeError("Native agent result unresolved; no automatic retry") from None
    if process.returncode:
        record(
            "native_error",
            framework=framework,
            exit_code=process.returncode,
            detail=stderr.decode(errors="replace").replace(key, "[REDACTED]"),
        )
        raise RuntimeError(f"Native agent exited with {process.returncode}; inspect runtime logs")
    if framework == "openclaw":
        result = json.loads(stdout.decode())
        meta = result.get("meta", {})
        if meta.get("aborted") or meta.get("stopReason") != "stop":
            raise RuntimeError("OpenClaw did not finish successfully")
        payloads = result.get("payloads", [])
        answer = "\n".join(p["text"] for p in payloads if isinstance(p.get("text"), str))
        if not answer.strip():
            raise RuntimeError("OpenClaw returned no final text")
        calls = []
        role = env.get("ENVARPAY_AGENT_ROLE", "seller")
        database = Path("/runtime-home/agents") / role / "agent/openclaw-agent.sqlite"
        session_id = meta.get("agentMeta", {}).get("sessionId")
        if database.exists() and session_id:
            try:
                with sqlite3.connect(f"file:{database}?mode=ro", uri=True) as db:
                    for (event_json,) in db.execute(
                        "SELECT event_json FROM transcript_events "
                        "WHERE session_id=? AND event_json IS NOT NULL ORDER BY seq",
                        (session_id,),
                    ):
                        message = json.loads(event_json).get("message", {})
                        if message.get("role") == "assistant":
                            calls.extend(
                                p
                                for p in message.get("content", [])
                                if isinstance(p, dict) and p.get("type") == "toolCall"
                            )
            except (sqlite3.Error, ValueError):
                record("trace_capture_incomplete", framework=framework, session_id=session_id)
        record(
            "native_run_finished",
            framework=framework,
            payloads=payloads,
            execution_trace=meta.get("executionTrace"),
            agent_meta=meta.get("agentMeta"),
            tool_calls=calls,
        )
        return answer
    if framework == "goose":
        text = stdout.decode()
        result = None
        for index, character in enumerate(text):
            if character != "{":
                continue
            try:
                candidate, _ = json.JSONDecoder().raw_decode(text[index:])
            except json.JSONDecodeError:
                continue
            if isinstance(candidate, dict) and "messages" in candidate and "metadata" in candidate:
                result = candidate
                break
        if not result or result["metadata"].get("status") != "completed":
            raise RuntimeError("Goose did not finish successfully; no automatic retry")
        messages = [m for m in result["messages"] if m.get("role") == "assistant"]
        if not messages or any(
            p.get("type") in ("toolRequest", "actionRequired", "error")
            for p in messages[-1]["content"]
        ):
            raise RuntimeError("Goose returned no final answer")
        answer = "\n".join(p["text"] for p in messages[-1]["content"] if p.get("type") == "text")
        if not answer.strip():
            raise RuntimeError("Goose returned no final text")
        record("native_run_finished", framework=framework, messages=result["messages"])
        return answer
    events = []
    for line in stdout.decode().splitlines():
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            events.append(value)
    if any(e.get("type") == "error" for e in events):
        raise RuntimeError("Native agent returned an error; no automatic retry")
    if framework == "hermes":
        results = [e for e in events if e.get("type") == "result"]
        if not results or results[-1].get("exit_code") != 0 or results[-1].get("error"):
            raise RuntimeError("Hermes did not return a completed result")
        answer = results[-1].get("text")
        if not isinstance(answer, str) or not answer.strip():
            raise RuntimeError("Hermes returned no final text")
        record("native_run_finished", framework=framework, events=events)
        return answer
    texts = [e["part"]["text"] for e in events if e.get("type") == "text"]
    finishes = [e for e in events if e.get("type") == "step_finish"]
    if not texts or not finishes or finishes[-1]["part"].get("reason") != "stop":
        raise RuntimeError("Native agent returned no completed text result")
    record("native_run_finished", framework="opencode", events=events)
    return texts[-1]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("role", choices=["seller", "buyer", "smoke"])
    parser.add_argument(
        "--framework", choices=["opencode", "goose", "hermes", "openclaw"], default="opencode"
    )
    parser.add_argument("--prompt-file")
    args = parser.parse_args()
    if args.role == "seller":
        from mcp.server.fastmcp import FastMCP

        mcp = FastMCP(args.framework + " source seller", host="0.0.0.0", port=8000)

        @mcp.tool()
        async def ask_agent(question: str) -> str:
            record(
                "seller_started",
                framework=args.framework,
                question_sha256=hashlib.sha256(question.encode()).hexdigest(),
            )
            result = await invoke(question, args.framework)
            record("seller_delivered", framework=args.framework, result=result)
            return result

        mcp.run(transport="streamable-http")
    else:
        result = asyncio.run(invoke(Path(args.prompt_file).read_text(), args.framework))
        record(
            "buyer_delivered" if args.role == "buyer" else "smoke_finished",
            framework=args.framework,
            result=result,
        )
        print(json.dumps({"answer": result}))


if __name__ == "__main__":
    main()
