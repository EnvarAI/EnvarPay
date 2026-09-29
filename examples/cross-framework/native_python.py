"""Native framework buyer/seller loops. Requires real model and MCP services."""

import argparse
import asyncio
import hashlib
import json
import os
import time
from pathlib import Path


def record(event, **data):
    path = Path("/evidence/events.jsonl")
    with path.open("a") as f:
        f.write(json.dumps({"event": event, "at": time.time(), **data}) + "\n")


def model_key():
    return Path("/run/secrets/llm_api_key").read_text().strip()


def model_name():
    return os.environ.get("MODEL_NAME", "gpt-4.1-mini")


def model_url():
    return os.environ.get("MODEL_BASE_URL", "https://api.openai.com/v1")


async def invoke(framework, question, wallet_config=None):
    if framework == "langgraph":
        from fastmcp.client.transports import StdioTransport
        from langchain.agents import create_agent
        from langchain.mcp import MCPAdapter
        from langchain_openai import ChatOpenAI

        model = ChatOpenAI(
            model=model_name(),
            base_url=model_url(),
            api_key=model_key(),
            max_retries=0,
            timeout=120,
        )
        if wallet_config:
            transport = StdioTransport(
                command="/opt/envarpay/.venv/bin/envarpay",
                args=["wallet", "--config", wallet_config],
            )
            async with MCPAdapter(transport) as adapter:
                tools = await adapter.list_tools()
                agent = create_agent(model, tools)
                result = await agent.ainvoke({"messages": [{"role": "user", "content": question}]})
        else:
            agent = create_agent(model, [])
            result = await agent.ainvoke({"messages": [{"role": "user", "content": question}]})
        calls = [c for m in result["messages"] for c in getattr(m, "tool_calls", [])]
        record("native_run_finished", framework=framework, tool_calls=calls)
        return result["messages"][-1].content
    from fastmcp.client.transports import StdioTransport
    from pydantic_ai import Agent
    from pydantic_ai.mcp import MCPToolset
    from pydantic_ai.models.openai import OpenAIChatModel
    from pydantic_ai.providers.openai import OpenAIProvider

    model = OpenAIChatModel(
        model_name(),
        provider=OpenAIProvider(base_url=model_url(), api_key=model_key()),
    )
    toolsets = []
    if wallet_config:
        toolsets = [
            MCPToolset(
                StdioTransport(
                    command="/opt/envarpay/.venv/bin/envarpay",
                    args=["wallet", "--config", wallet_config],
                )
            )
        ]
    agent = Agent(model, toolsets=toolsets, retries=0)
    async with agent:
        result = await agent.run(question)
    calls = []
    for message in result.all_messages():
        for part in message.parts:
            if getattr(part, "part_kind", None) == "tool-call":
                calls.append({"name": part.tool_name, "arguments": part.args_as_dict()})
    record("native_run_finished", framework=framework, tool_calls=calls)
    return result.output


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("framework", choices=["langgraph", "pydantic-ai"])
    parser.add_argument("role", choices=["seller", "buyer", "probe"])
    parser.add_argument("--prompt-file")
    parser.add_argument("--config")
    args = parser.parse_args()
    if args.role == "seller":
        from fastmcp import FastMCP

        mcp = FastMCP(args.framework + " seller")

        @mcp.tool()
        async def ask_agent(question: str) -> str:
            record(
                "seller_started",
                framework=args.framework,
                question_sha256=hashlib.sha256(question.encode()).hexdigest(),
            )
            result = await invoke(args.framework, question)
            record("seller_delivered", framework=args.framework, result=result)
            return result

        mcp.run(transport="http", host="0.0.0.0", port=8000)
    elif args.role == "buyer":
        question = Path(args.prompt_file).read_text()
        answer = asyncio.run(invoke(args.framework, question, args.config))
        record("buyer_delivered", framework=args.framework, result=answer)
        print(json.dumps({"answer": answer}))
    else:

        async def probe():
            from fastmcp.client.transports import StdioTransport

            transport = StdioTransport(
                command="/opt/envarpay/.venv/bin/envarpay", args=["wallet", "--config", args.config]
            )
            if args.framework == "langgraph":
                from langchain.mcp import MCPAdapter

                async with MCPAdapter(transport) as adapter:
                    tools = await adapter.list_tools()
                    print(json.dumps({"tools": [t.name for t in tools]}))
                    status = next(t for t in tools if t.name == "payment_status")
                    print(await status.ainvoke({"request_id": "never-attempted"}))
            else:
                from pydantic_ai.mcp import MCPToolset

                async with MCPToolset(transport) as toolset:
                    print(json.dumps({"tools": [t.name for t in await toolset.list_tools()]}))
                    print(
                        await toolset.direct_call_tool(
                            "payment_status", {"request_id": "never-attempted"}
                        )
                    )

        asyncio.run(probe())


if __name__ == "__main__":
    main()
