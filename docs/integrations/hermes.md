# Hermes

## Pay another agent

Install EnvarPay in a dedicated environment; initialize/review `buyer.toml`.
Then print this host's native MCP entry:

```sh
envarpay host-config --host hermes --config /absolute/path/buyer.toml
```

Merge that entry into the host configuration. Wallet tools are `list_paid_tools`,
`call_paid_tool`, and `payment_status`. The wallet defaults to payments OFF.
It only spends on configured peers, recipients and tools, within its persistent budget.

The [official main-source Docker run](validation.md) uses the source SHA in
[sources.json](../../examples/cross-framework/sources.json), not the local installation.
The [native profile](../../examples/cross-framework/profiles/hermes/buyer/) and
[CLI wrapper](../../examples/cross-framework/native_cli.py) show the tested configuration.

## Tested seller path: private MCP + native CLI

Run the native wrapper in seller mode, then put an EnvarPay MCP-backend payment gate
in front of its private `ask_agent` tool. (The backend is selected
with `envarpay init --backend mcp`; `serve` reads that seller config.)
The actual native CLI performs the task after the outer payment gate confirms it.
See [Docker instructions](../../examples/cross-framework/README.md). This creates a
new dedicated native task, not a continuation of your personal conversation.

Install Hermes's optional MCP dependencies in its own environment. The current
main-source test uses `/opt/hermes-latest/bin/hermes chat --oneshot --format stream-json`.
The base image's old Hermes executable is not used for the matrix.

## Receive payment using your existing agent service

**Experimental source-preview connector; Gateway HTTP paid acceptance is pending; the native MCP/CLI matrix does not cover it.**

Enable `API_SERVER_ENABLED=true`, set `API_SERVER_KEY`, and run `hermes gateway` in a dedicated seller profile. The generated target is `hermes-agent`.

```sh
envarpay init --directory ./agent-pay --pay-to YOUR_FULL_ADDRESS --backend hermes-http
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

## Optional embedded mode

`--backend hermes` still creates a fresh AIAgent with its own model configuration.
It skips memory, workspace context and soul identity; it does not attach to an
existing CLI/Gateway session. Only that embedded mode needs EnvarPay installed
inside the compatible Hermes Python environment. Keep it distinct from `hermes-http`.

## Official sources

- [Native MCP client](https://github.com/NousResearch/hermes-agent/blob/v2026.9.24/website/docs/user-guide/features/mcp.md)
- [API server](https://github.com/NousResearch/hermes-agent/blob/v2026.9.24/website/docs/user-guide/features/api-server.md)
- [Programmatic integration and in-process option](https://github.com/NousResearch/hermes-agent/blob/v2026.9.24/website/docs/developer-guide/programmatic-integration.md)
- [A2A plugin](https://github.com/NousResearch/hermes-agent/blob/v2026.9.24/website/docs/user-guide/messaging/a2a.md)
- [Current EnvarPay adapter](../../src/envarpay/backend.py)
