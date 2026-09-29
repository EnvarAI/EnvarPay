"""Portable native LangChain/Pydantic AI MCP examples; use a separate framework venv.

Probe needs no model credential and never calls a paid tool. Buyer uses the
framework's real model/tool loop. Seller exposes a private MCP tool; place the
EnvarPay gate in front of it before offering it for payment.
"""

import argparse
import asyncio
import json
import os
from pathlib import Path


def wallet_client(command_file):
    from fastmcp import Client
    from fastmcp.client.transports import StdioTransport

    command = json.loads(Path(command_file).read_text())
    return Client(StdioTransport(**command), mode="legacy", timeout=750, init_timeout=30)


async def run_agent(framework, question, command_file=None):
    model_name = os.environ["MODEL_NAME"]
    base_url = os.environ["MODEL_BASE_URL"]
    api_key = os.environ["MODEL_API_KEY"]
    if framework == "langgraph":
        from langchain.agents import create_agent
        from langchain.mcp import MCPAdapter
        from langchain_openai import ChatOpenAI

        model = ChatOpenAI(
            model=model_name, base_url=base_url, api_key=api_key, max_retries=0, timeout=120
        )
        if command_file:
            async with MCPAdapter(wallet_client(command_file)) as adapter:
                agent = create_agent(model, await adapter.list_tools())
                result = await agent.ainvoke({"messages": [{"role": "user", "content": question}]})
        else:
            result = await create_agent(model, []).ainvoke(
                {"messages": [{"role": "user", "content": question}]}
            )
        return result["messages"][-1].content
    from pydantic_ai import Agent
    from pydantic_ai.mcp import MCPToolset
    from pydantic_ai.models.openai import OpenAIChatModel
    from pydantic_ai.providers.openai import OpenAIProvider

    model = OpenAIChatModel(model_name, provider=OpenAIProvider(base_url=base_url, api_key=api_key))
    toolsets = [MCPToolset(wallet_client(command_file))] if command_file else []
    async with Agent(model, toolsets=toolsets, retries=0) as agent:
        return (await agent.run(question)).output


async def probe(framework, command_file):
    if framework == "langgraph":
        from langchain.mcp import MCPAdapter

        async with MCPAdapter(wallet_client(command_file)) as adapter:
            tools = await adapter.list_tools()
            status = next(tool for tool in tools if tool.name == "payment_status")
            return {
                "tools": [tool.name for tool in tools],
                "status": await status.ainvoke({"request_id": "setup-check-never-paid"}),
            }
    from pydantic_ai.mcp import MCPToolset

    async with MCPToolset(wallet_client(command_file)) as toolset:
        return {
            "tools": [tool.name for tool in await toolset.list_tools()],
            "status": await toolset.direct_call_tool(
                "payment_status", {"request_id": "setup-check-never-paid"}
            ),
        }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("framework", choices=["langgraph", "pydantic-ai"])
    parser.add_argument("role", choices=["probe", "buyer", "seller"])
    parser.add_argument(
        "--wallet-command", help="Generated wallet-command.json; trusted operator file"
    )
    parser.add_argument("--question")
    parser.add_argument("--request-id")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    if args.role != "seller" and not args.wallet_command:
        parser.error("--wallet-command is required for probe and buyer")
    if args.role != "probe":
        required = ("MODEL_NAME", "MODEL_BASE_URL", "MODEL_API_KEY")
        if any(not os.environ.get(name, "").strip() for name in required):
            parser.error("Configure MODEL_NAME, MODEL_BASE_URL and MODEL_API_KEY before starting")
    if args.role == "probe":
        print(asyncio.run(probe(args.framework, args.wallet_command)))
    elif args.role == "buyer":
        if not args.request_id or not args.question:
            parser.error("buyer requires --request-id and --question")
        purchase = {
            "peer": "seller",
            "tool": "ask_agent",
            "request_id": args.request_id,
            "arguments": {"question": args.question},
        }
        prompt = (
            "Use call_paid_tool exactly once with "
            + json.dumps(purchase)
            + ". Return the seller result. On error or uncertainty, stop. "
            "Do not solve the task yourself, change the request ID, or buy again."
        )
        print(asyncio.run(run_agent(args.framework, prompt, args.wallet_command)))
    else:
        from fastmcp import FastMCP

        server = FastMCP(args.framework + " private capability")

        @server.tool()
        async def ask_agent(question: str) -> str:
            return str(await run_agent(args.framework, question))

        server.run(transport="http", host=args.host, port=args.port)


if __name__ == "__main__":
    main()
