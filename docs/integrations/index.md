# Choose your agent

EnvarPay provides a **buyer wallet** and a **seller payment gate**. Configure them independently.
The package, Python import and CLI are all `envarpay` (unreleased source preview 0.1.0a2).

| Agent | Pay others | Charge for work | Native local Docker validation |
|---|---|---|---|
| [OpenClaw](openclaw.md) | `host-config --host openclaw`, native MCP bridge | Native CLI exposed as private MCP | Paid directions recorded in the matrix |
| [Hermes](hermes.md) | `host-config --host hermes`, native MCP client | Native CLI exposed as private MCP | Paid directions recorded in the matrix |
| [OpenCode](other-runtimes.md#opencode) | `host-config --host opencode` | `opencode run` exposed as private MCP | Paid directions recorded in the matrix |
| [Goose](other-runtimes.md#goose) | `host-config --host goose` | `goose run` exposed as private MCP | Paid directions recorded in the matrix |
| [LangGraph / LangChain](other-runtimes.md#langgraph-and-langchain) | Official `MCPAdapter` | Native `create_agent().ainvoke()` behind MCP | Paid directions recorded in the matrix |
| [Pydantic AI](other-runtimes.md#pydantic-ai) | Official `MCPToolset` | Native `Agent.run()` behind MCP | Paid directions recorded in the matrix |

The [transaction matrix](validation.md) records successful purchases **and failed settlements**.
Each framework has acted as buyer and seller. This is not a claim that every direction passed.
The [runnable harness, profiles and Docker recipes](../../examples/cross-framework/README.md)
show precisely which path was tested. Existing OpenClaw/Hermes Gateway HTTP connectors
remain experimental and are **not** covered by these MCP/native-runtime payment results.

## Add a buyer wallet

```sh
envarpay host-config --host openclaw --config /absolute/path/buyer.toml
envarpay host-config --host hermes --config /absolute/path/buyer.toml
envarpay host-config --host opencode --config /absolute/path/buyer.toml
envarpay host-config --host goose --config /absolute/path/buyer.toml
```

Choose your host, then merge the printed entry into its configuration. The command
never edits personal configuration, creates a wallet, enables payments or resets state.
The agent receives `list_paid_tools`, `call_paid_tool` and `payment_status`.
The separate wallet process enforces configured peers, exact recipients, tools and budgets.

## Add a seller gate

Expose the capability you want to sell as a private MCP tool. Initialize with
`envarpay init --directory ./agent-pay --pay-to YOUR_FULL_ADDRESS --backend mcp`.
Set the private upstream endpoint and tool price in `seller.toml`, then run
`envarpay serve --config ./agent-pay/seller.toml`. Only the gate should be public.
The receiving address needs no private key in the seller service.

The native CLI wrappers start a dedicated task with the configured profile. They
are examples, not attachments to an existing personal conversation. The Python
wrappers call the framework itself; no generic model client substitutes for it.

## Protocol and dependency boundaries

Official **MCP** carries tool calls, official **x402 v2** carries payment requests,
and official USDC **EIP-3009** authorizations settle on chain. EnvarPay supplies
local policy, persistence, receipt checks and adapters; EnvarPay itself is not a standard.
This SDK does not implement marketplace discovery or A2A task orchestration.

The wallet uses MCP 1.26.0. Current Python frameworks use FastMCP 4/MCP 2 in separate
environments. Their official `Client(..., mode="legacy")` connects to the wallet;
see the executable Python example. Do not force both dependency stacks into one environment.

Acceptance uses official development-branch commits resolved on 2026-09-29:
`main` for OpenClaw, Hermes, Goose, LangGraph and Pydantic AI; `dev` for OpenCode;
`master` for LangChain. [Full SHAs](../../examples/cross-framework/sources.json) stay
fixed during the matrix. Host-installed versions do not count.
