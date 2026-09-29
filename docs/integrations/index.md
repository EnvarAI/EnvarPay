# Choose your agent

EnvarPay has two independent components: a **buyer wallet MCP server** and a
**seller payment gate** in front of a private capability. The same package works
across frameworks; each agent keeps its native execution/tool loop.

| Agent | Guide | Buyer connection | Seller capability |
|---|---|---|---|
| OpenClaw | [Step by step](openclaw.md) | `mcp.servers.envarpay` | Native CLI/MCP wrapper |
| Hermes | [Step by step](hermes.md) | `mcp_servers.envarpay` | Native CLI/MCP wrapper |
| OpenCode | [Step by step](opencode.md) | `mcp.envarpay` | Native CLI/MCP wrapper |
| Goose | [Step by step](goose.md) | `extensions.envarpay` | Headless CLI/MCP wrapper |
| LangGraph / LangChain | [Step by step](langgraph.md) | Official `MCPAdapter` | Graph/agent invocation as MCP |
| Pydantic AI | [Step by step](pydantic-ai.md) | Official `MCPToolset` | `Agent.run()` as MCP |

Start with `envarpay init --agent NAME --role buyer` or `--role seller`, supplying
the relevant receiving address with `--pay-to`. The [configuration reference](../configuration.md)
explains peer URLs, private upstreams, prices, budgets and the both-role setup.
Initialization generates files and instructions; it does not install or modify your agent.

## Generic MCP client or service

Buyer: use `--agent mcp --role buyer`, then load the generated `wallet-command.json`
as your native client's stdio process. It runs EnvarPay in its own environment.
The core tools are `list_paid_tools`, `call_paid_tool`, `payment_status`, and `recover_payment`.
Your client's built-in MCP support alone does not sign x402 payments; the wallet does.

Seller: use `--agent mcp --role seller --upstream PRIVATE_MCP_URL --tool TOOL_NAME`.
Run `envarpay serve --config .../seller.toml` and publish only the gate. This works
with existing Streamable HTTP, SSE or stdio tools; see [selling a capability](../selling.md).

## What was actually tested

The [Docker matrix](validation.md) records **28 real paid deliveries in 30 attempted
directions**, including two failures. All six frameworks bought and sold. The run
used official development-branch sources resolved to full commits, not old local installations.
The exact runtime/source/image and transaction evidence is linked there.

The existing OpenClaw/Hermes **Gateway HTTP** connectors have a separate experimental
status. Their existence does not prove paid acceptance for an existing personal session.
Native wrappers in the matrix start dedicated tasks using dedicated profiles.

## Protocol and dependency boundaries

MCP standardizes tools, x402 v2 standardizes payment messages, and USDC EIP-3009
supplies the on-chain authorization. EnvarPay adds operator policy, persistent
state, exact receipt checks and adapters. It is not a new payment protocol.

EnvarPay pins MCP 1.28.1. Current Python framework examples use FastMCP 4/MCP 2 in a
separate environment and the official `Client(..., mode="legacy")` setting. Do not
force incompatible dependency stacks into a shared venv. Follow the version-specific
framework guides and the pinned Docker examples for reproducible acceptance.
