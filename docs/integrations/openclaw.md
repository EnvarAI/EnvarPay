# OpenClaw

## Pay another agent

Install EnvarPay in a dedicated environment; initialize/review `buyer.toml`.
Then print this host's native MCP entry:

```sh
envarpay host-config --host openclaw --config /absolute/path/buyer.toml
```

Merge that entry into the host configuration. Wallet tools are `list_paid_tools`,
`call_paid_tool`, and `payment_status`. The wallet defaults to payments OFF.
It only spends on configured peers, recipients and tools, within its persistent budget.

The [official main-source Docker run](validation.md) uses the source SHA in
[sources.json](../../examples/cross-framework/sources.json), not the local installation.
The [native profile](../../examples/cross-framework/profiles/openclaw/buyer/) and
[CLI wrapper](../../examples/cross-framework/native_cli.py) show the tested configuration.

## Tested seller path: private MCP + native CLI

Run the native wrapper in seller mode, then put an EnvarPay MCP-backend payment gate
in front of its private `ask_agent` tool. (The backend is selected
with `envarpay init --backend mcp`; `serve` reads that seller config.)
The actual native CLI performs the task after the outer payment gate confirms it.
See [Docker instructions](../../examples/cross-framework/README.md). This creates a
new dedicated native task, not a continuation of your personal conversation.

Current main uses `agents.entries` and `memory.search`; older `agents.list` and
`agents.defaults.memorySearch` examples no longer match its schema. Persist the
workspace together with the profile (`/runtime-home/workspace` in the example).
Use a dedicated model-key variable; the test profile uses `ENVARPAY_MODEL_API_KEY`.
Do not delete workspace guards or reseed a lost profile to repair payment state.

## Receive payment using your existing agent service

**Experimental source-preview connector; Gateway HTTP paid acceptance is pending; the native MCP/CLI matrix does not cover it.**

Enable `gateway.http.endpoints.responses.enabled` on a dedicated Gateway. Create/select the fixed seller agent ID (the generated target is `openclaw/seller`).

```sh
envarpay init --directory ./agent-pay --pay-to YOUR_FULL_ADDRESS --backend openclaw
# Review seller.toml: existing /v1 URL, fixed target, price and runtime credential reference.
# Provide ENVARPAY_RUNTIME_TOKEN securely in the seller process environment.
envarpay doctor --config ./agent-pay/seller.toml
envarpay serve --config ./agent-pay/seller.toml
```

The connector sends a text-only, non-streaming request after the seller verifies
the original payment receipt. Agent tools, provider and model configuration stay
in the existing runtime. Buyers cannot choose operator headers, target agents,
model overrides or session IDs. Each call uses the runtime's fresh-session behavior.
Only a completed final answer counts as delivery. Pending work, commentary,
unresolved client tool calls, oversized responses and timeouts are not success.

Keep the raw Gateway private. Its bearer credential carries operator authority;
use a dedicated seller instance/workspace and expose only the payment gate.
There are no HTTP redirects, inherited proxies or automatic retries on runtime calls.
Long-running jobs, approval resumption and automatic refunds are not implemented.
On an uncertain result, preserve the original payment and execution state.

`doctor` validates local configuration and credential availability, not agent
reachability or paid delivery. [Actual validation](validation.md) is recorded separately.

## Official sources

- [MCP client guide, v2026.9.6](https://github.com/openclaw/openclaw/blob/v2026.9.6/docs/tools/mcp.md)
- [MCP config schema, v2026.9.6](https://github.com/openclaw/openclaw/blob/v2026.9.6/src/config/zod-schema.mcp-server.ts)
- [MCP CLI registry and probing](https://github.com/openclaw/openclaw/blob/v2026.9.6/docs/cli/mcp/registry.md)
- [Gateway OpenResponses API](https://github.com/openclaw/openclaw/blob/v2026.9.6/docs/gateway/openresponses-http-api.md)
- [MCP server bridge scope](https://docs.openclaw.ai/cli/mcp/serve)
- [Plugin SDK](https://docs.openclaw.ai/plugins/sdk-overview)
