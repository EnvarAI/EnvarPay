# Hermes

**Status:** EnvarPay's wallet-tool registration and embedded seller were tested
with official Hermes 0.20.0. Additional interface research checked the Hermes
**v2026.9.24** documentation. A connector to an existing Gateway has not shipped.

## Give Hermes a payment tool

Install EnvarPay into a separate environment, prepare `buyer.toml`, then run:

```sh
envar-pay hermes-config --config /absolute/path/to/buyer.toml
```

The existing command emits the correct `mcp_servers.payments` entry with absolute
interpreter/config paths. Merge it into Hermes's `config.yaml`; do not overwrite
the rest of your configuration. Its essential shape is:

```yaml
mcp_servers:
  payments:
    command: /absolute/path/to/envarpay-venv/bin/envar-pay
    args: [wallet, --config, /absolute/path/to/buyer.toml]
    timeout: 600
    connect_timeout: 30
```

Keep payment disabled until the wallet holder has reviewed the chain, asset,
recipient and budget. Hermes should discover `list_paid_tools`, `call_paid_tool`
and `payment_status`; discovery is not proof of payment. If the environment
needs proxy or peer-auth variables, explicitly pass them in the MCP entry's
`env` mapping. Do not put private-key values in the model's prompt or a Skill.

## Current seller mode: create an embedded Hermes instance

`envar-pay serve` with `backend.kind = "hermes"` imports `run_agent.AIAgent` and
constructs a fresh agent using the model, system prompt and toolsets from
EnvarPay's seller configuration. Direct in-process embedding is an official
Hermes integration option.

However, the current adapter explicitly skips memory, workspace context files
and soul identity. It **does not attach to your existing CLI/Gateway session**.
This mode is suitable when you intend to run a separately configured seller.
It should not be described as enabling payments on your existing personal agent
with its complete identity and conversation history.

## Proposed seller mode: connect to your existing Hermes Gateway

Hermes has a documented API server with authentication:

- `API_SERVER_ENABLED=true`, `API_SERVER_KEY` and `hermes gateway` enable it.
- The default loopback endpoint is `http://127.0.0.1:8642`.
- `/v1/chat/completions` supports synchronous/stateless calls; `/v1/responses`
  supports continuation; `/v1/capabilities` reports available features.
- `/v1/runs` and session APIs provide richer execution lifecycles when needed.

A new EnvarPay HTTP runtime connector should invoke that existing service after
payment. The user's model/provider/tools remain configured in Hermes. Start with
a bounded synchronous capability, then separately validate session ownership,
long-running task status, approvals, cancellation and recovery.

Use a dedicated seller profile/instance. The official API includes terminal and
file capabilities; a paying caller should not inherit unrestricted access to a
private assistant's files, messaging accounts or shared session history.

Hermes also has a bidirectional A2A plugin. That is useful for future task
interoperability, but EnvarPay 0.1.0a1 has no A2A payment adapter and must not
advertise one as already working.

## Official sources

- [Native MCP client](https://github.com/NousResearch/hermes-agent/blob/v2026.9.24/website/docs/user-guide/features/mcp.md)
- [API server](https://github.com/NousResearch/hermes-agent/blob/v2026.9.24/website/docs/user-guide/features/api-server.md)
- [Programmatic integration and in-process option](https://github.com/NousResearch/hermes-agent/blob/v2026.9.24/website/docs/developer-guide/programmatic-integration.md)
- [A2A plugin](https://github.com/NousResearch/hermes-agent/blob/v2026.9.24/website/docs/user-guide/messaging/a2a.md)
- [Current EnvarPay adapter](../../src/envar_pay/backend.py)
