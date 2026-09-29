# Other runtimes and developer frameworks

These are **documented candidate paths**, not claims of completed EnvarPay
payment acceptance tests. Research date: 2026-09-29. Keep the wallet in a separate
environment when the host uses different MCP/FastMCP versions.

## OpenCode

OpenCode v1.18.33 supports local MCP servers under its `mcp` configuration:

```json
{
  "mcp": {
    "envarpay": {
      "type": "local",
      "command": [
        "/absolute/path/to/venv/bin/envar-pay",
        "wallet", "--config", "/absolute/path/to/buyer.toml"
      ],
      "enabled": true,
      "timeout": 30000
    }
  }
}
```

This is a buyer-tool integration candidate. For selling an existing OpenCode
agent, its server and official **`@opencode-ai/sdk`** provide a concrete route:
`createOpencodeClient` connects to an existing instance, with session creation
and `session.prompt` calls. EnvarPay does not yet implement that seller adapter.
Use an isolated service workspace rather than exposing a developer's entire
interactive coding session.

Sources: [MCP](https://github.com/anomalyco/opencode/blob/v1.18.33/packages/web/src/content/docs/mcp-servers.mdx),
[JS/TS SDK](https://github.com/anomalyco/opencode/blob/v1.18.33/packages/web/src/content/docs/sdk.mdx),
[server API](https://opencode.ai/docs/server/).

## Goose

Goose supports custom STDIO MCP extensions. Its documented desktop flow is:
**Extensions → Type: STDIO → executable command**. Configure the EnvarPay wallet
command with an absolute path and buyer config, retaining the host's permissions
and the wallet's independent spending policy.

For selling, a dedicated `goose run`/recipe runner can be wrapped in a service,
but EnvarPay has not implemented or tested that path. Headless mode executes a
task and exits; this is not attachment to an existing desktop conversation.

The current **`goose-sdk`** has Python/Rust/Kotlin bindings for the **provider
layer**: model completion, streaming and compaction. Its existence does not prove
that it embeds the complete Goose agent/tool/session runtime. Do not substitute
that SDK for a full-agent connector without checking its scope.

Sources: [extension guide at v1.52.0](https://github.com/aaif-goose/goose/blob/v1.52.0/documentation/docs/tutorials/custom-extensions.md),
[headless execution](https://github.com/aaif-goose/goose/blob/b92a80daf4a77d7e854709965bdfdc489c0472d2/documentation/docs/tutorials/headless-goose.md),
[SDK scope at inspected commit](https://github.com/aaif-goose/goose/blob/b92a80daf4a77d7e854709965bdfdc489c0472d2/documentation/docs/gdk/sdk/index.md).

## LangGraph and LangChain

Buyer: current LangChain documentation exposes `langchain.mcp.MCPAdapter` through
the MCP extra; earlier versions use `langchain-mcp-adapters`. Use a version-specific
guide, or register a Python tool that delegates to `WalletService.call()` in a
compatible environment.

Seller: **Agent Server** exposes deployed LangGraph agents as tools at `/mcp`
using Streamable HTTP, which is a candidate for EnvarPay's existing MCP backend.
The library alone is not that deployed server. Its documented MCP endpoint is
stateless; do not infer persistence of a buyer's conversation from MCP support.
An alternative is explicitly wrapping a graph invocation in an MCP tool.

Sources: [LangChain MCP](https://docs.langchain.com/oss/python/langchain/mcp),
[Agent Server MCP](https://docs.langchain.com/langsmith/server-mcp).

## Pydantic AI

Buyer: current documentation provides the MCP capability and `MCPToolset`, with
stdio, SSE and Streamable HTTP through FastMCP. Connect to the separately running
wallet rather than assuming its dependency stack can share the EnvarPay environment.

Seller: explicitly expose a bounded `Agent.run()` operation as an MCP tool, then
use the existing priced-MCP backend. EnvarPay currently lacks a direct
`@paid` callable decorator; no such API is implied by calling the package an SDK.

Source: [Pydantic AI MCP client](https://pydantic.dev/docs/ai/mcp/client/).

## What SDK means here

There are three separate libraries people may call an SDK:

1. A runtime SDK invokes or extends the agent (for example OpenCode's JS client).
2. The official x402 SDK implements payment payloads, verification and settlement.
3. EnvarPay composes payment policy and runtime invocation, and exposes a Python API/CLI.

EnvarPay should distinguish launching a new embedded agent from attaching to an
existing service, and cannot claim an integration merely because it supports MCP.
Support claims need a pinned version and an end-to-end test for each direction.
