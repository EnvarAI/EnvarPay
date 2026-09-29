# Choose your agent

EnvarPay has a buyer wallet and a seller payment gate. Configure them independently.
Source preview: package, Python import and CLI are all **envarpay**, version 0.1.0a2.
The previous GitHub release remains 0.1.0a1 with its old names; PyPI publication is pending.

| Your agent | Pay others | Charge for work | Validation |
|---|---|---|---|
| [OpenClaw](openclaw.md) | Generate native `mcp.servers` config | Experimental existing Gateway `/v1/responses` connector | New host version and live paid acceptance pending |
| [Hermes](hermes.md) | Generate native `mcp_servers` config | Experimental existing API server connector, or embedded Hermes | Earlier embedded tests; local optional MCP dependency missing |
| [OpenCode](other-runtimes.md#opencode) | Generate native local MCP config | Own runtime SDK/service wrapper still needed | Local 1.15.13 connected to wallet; no paid run |
| [Goose](other-runtimes.md#goose) | Configure a STDIO MCP extension | Own headless-service wrapper still needed | Native runtime test pending |
| [LangGraph / LangChain](other-runtimes.md#langgraph-and-langchain) | MCP adapter in separate environment | Existing Agent Server MCP, or wrap your graph | Runtime compatibility test pending |
| [Pydantic AI](other-runtimes.md#pydantic-ai) | MCPToolset in separate environment | Wrap your Agent.run as MCP | Runtime compatibility test pending |

See the [validation ledger](validation.md) for versions, failures and acceptance
criteria. No new cross-framework chain payment has occurred.

## Generate a buyer configuration

```sh
envarpay host-config --host openclaw --config /absolute/path/buyer.toml
envarpay host-config --host hermes --config /absolute/path/buyer.toml
envarpay host-config --host opencode --config /absolute/path/buyer.toml
```

These commands print snippets. Merge the selected entry yourself; they do not
edit personal host configuration, create a wallet, enable payments or reset state.
Only the EnvarPay executable needs EnvarPay's dependencies. Your host keeps its
own environment and its tool permissions. The independent wallet enforces its
own allowlist and persistent budget.

## Dependency boundary

EnvarPay pins MCP 1.26.0. The researched FastMCP 4.0.10 client needs MCP >=2,<3;
current LangChain's MCP extra selects FastMCP 4. Use separate environments.
Dependency isolation alone does not prove compatible MCP negotiation.
The HTTP connector is an **internal runtime adapter**; the paid public endpoint
remains MCP/x402. It is not an HTTP 402 server or an A2A implementation.
