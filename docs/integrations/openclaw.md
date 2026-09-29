# OpenClaw

**Status:** documented integration candidate, checked against OpenClaw
**v2026.9.6**. No OpenClaw model run or EnvarPay payment was performed for this
research. Check your installed version before applying this configuration.

## Give OpenClaw a payment tool

OpenClaw has a native MCP client. Its configuration is **`mcp.servers`**, not
Hermes's `mcp_servers` or OpenCode's `mcp`. The current release supports stdio,
SSE and Streamable HTTP. No OpenClaw plugin is necessary for this first path.

1. Install EnvarPay in a separate Python environment and prepare `buyer.toml`
   using the [setup guide](../getting-started.md#enable-paying-for-other-agents).
   Leave `payments_enabled = false` for tool discovery.
2. Merge this entry into OpenClaw's configuration, replacing both absolute paths:

```json
{
  "mcp": {
    "servers": {
      "envarpay": {
        "enabled": true,
        "transport": "stdio",
        "command": "/absolute/path/to/venv/bin/envar-pay",
        "args": ["wallet", "--config", "/absolute/path/to/buyer.toml"],
        "connectionTimeoutMs": 30000,
        "requestTimeoutMs": 600000,
        "toolFilter": {
          "include": ["list_paid_tools", "call_paid_tool", "payment_status"]
        }
      }
    }
  }
}
```

3. Inspect reachability without signing a payment:

```sh
openclaw mcp doctor envarpay --probe
```

This should list the wallet's tools. It proves discovery only. OpenClaw's selected
tool profile and policy still apply: the documented `minimal` profile hides MCP
tools; `coding`/`messaging` expose them unless denied. Do not change approval
settings just to suppress a prompt. The wallet's monetary policy is independent
of the host's approval UI.

4. Before an actual call, the wallet holder reviews the chain, official token,
   complete seller address and amount/budget, funds the dedicated wallet and
   explicitly enables payment in the wallet config. Keep the same request ID
   when retrying the same purchase. An unknown result is not permission to pay again.

## Sell a capability of an existing OpenClaw

**This part needs new EnvarPay implementation.** OpenClaw already offers the
necessary upstream execution interface:

- Enable its Gateway `/v1/responses` endpoint using
  `gateway.http.endpoints.responses.enabled` (off by default).
- It runs through the normal Gateway agent path, using its routing, permissions
  and configuration.
- Select a dedicated seller agent with the documented model value
  `openclaw/<agentId>` or `x-openclaw-agent-id` header.
- A future EnvarPay HTTP connector should fix that agent target and expose only
  the intended capability inputs; after verified payment it invokes the local
  Gateway and returns the terminal result.

Do not paste the Gateway operator credential into the buyer's configuration or
expose the Gateway directly as a public paid endpoint. The official docs treat
this API as operator access. Use a dedicated seller agent/workspace and derive
per-buyer/task sessions server-side; requests are stateless by default unless
explicitly routed to a stable session.

**Do not use `openclaw mcp serve` as a generic paid-task executor.** That command
exposes routed channel conversations, history, message sending and approvals.
Its `messages_send` sends back through an existing channel route. It is not the
same contract as invoking a selected agent and receiving a completed result.

## Does OpenClaw have an SDK?

Yes: its plugin SDK exposes typed TypeScript entry points and tool registration.
A native plugin can be considered for OpenClaw-specific UI/configuration later.
The lower-cost first buyer integration is the already-supported MCP client; the
seller integration can use the existing Gateway API without replacing OpenClaw.

## Official sources

- [MCP client guide, v2026.9.6](https://github.com/openclaw/openclaw/blob/v2026.9.6/docs/tools/mcp.md)
- [MCP config schema, v2026.9.6](https://github.com/openclaw/openclaw/blob/v2026.9.6/src/config/zod-schema.mcp-server.ts)
- [MCP CLI registry and probing](https://github.com/openclaw/openclaw/blob/v2026.9.6/docs/cli/mcp/registry.md)
- [Gateway OpenResponses API](https://github.com/openclaw/openclaw/blob/v2026.9.6/docs/gateway/openresponses-http-api.md)
- [MCP server bridge scope](https://docs.openclaw.ai/cli/mcp/serve)
- [Plugin SDK](https://docs.openclaw.ai/plugins/sdk-overview)
