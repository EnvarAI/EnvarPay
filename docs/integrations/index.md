# Choose your agent

Research checked on **2026-09-29**. Receiving payment and making payment are
different integrations. A runtime having MCP support does not establish an
end-to-end EnvarPay payment test.

| Your runtime | Paying other agents | Selling its capabilities | EnvarPay evidence |
|---|---|---|---|
| [OpenClaw](openclaw.md) | Native `mcp.servers` can launch the wallet MCP | Gateway HTTP API provides an existing-agent execution path; EnvarPay needs an HTTP runtime connector | Official release docs/schema checked; full integration not run |
| [Hermes](hermes.md) | Native `mcp_servers`; existing wallet integration | Current embedded `AIAgent` mode, or a future connector to the existing Gateway API | Wallet registration and embedded model execution tested; existing-Gateway connector not implemented |
| [OpenCode](other-runtimes.md#opencode) | Local MCP server entry under `mcp` | Existing server plus official JS/TS SDK session calls | Official release docs checked; full integration not run |
| [Goose](other-runtimes.md#goose) | Custom STDIO MCP extension | Dedicated headless/recipe runner behind a service wrapper | Official docs checked; full integration not run |
| [LangGraph / LangChain](other-runtimes.md#langgraph-and-langchain) | MCP adapter or a Python tool calling the wallet SDK | Agent Server's MCP endpoint, or an explicit function-to-MCP wrapper | Official interfaces checked; full integration not run |
| [Pydantic AI](other-runtimes.md#pydantic-ai) | `MCPToolset` / MCP capability, preferably in another environment | Wrap `Agent.run()` in an MCP tool | Official interfaces checked; full integration not run |

**Current release names:** `pip` distribution/CLI `envar-pay`, Python import
`envar_pay` (`0.1.0a1`). The proposed next release unifies them as `envarpay`.
The snippets in these guides deliberately use the existing executable; they do
not pretend the renamed release is already available.

## What is actually available today?

- The wallet is a stdio MCP service exposing `list_paid_tools`, `call_paid_tool`
  and `payment_status`. Other MCP-capable hosts have a documented route to it.
- The seller supports a configured MCP upstream or an **embedded Hermes instance**.
  It does not yet attach to arbitrary HTTP agent services.
- The Python SDK exposes `WalletService` and `PaidServer`; it is a payment
  integration library, not a replacement agent framework.
- The real payment evidence is the earlier two-Hermes testnet POC. OpenClaw,
  OpenCode, Goose and framework integrations have **not** passed new on-chain
  payment acceptance tests.

## Avoid a shared dependency environment by default

EnvarPay 0.1.0a1 pins MCP 1.26.0. At research time, FastMCP 4.0.10's client extra
requires MCP >=2,<3; LangChain's current MCP extra selects FastMCP 4. Installing
all of these into one environment creates incompatible requirements. Run the
wallet in its own environment and connect over MCP; verify protocol negotiation
with the specific host/version. An in-process Python SDK integration needs a
separate dependency compatibility check.

For the tested embedded Hermes mode, see its guide. Native plugins and TypeScript
SDKs may improve onboarding later, but are not prerequisites for a runtime that
already consumes MCP. A native OpenClaw plugin has not been shipped by EnvarPay.
