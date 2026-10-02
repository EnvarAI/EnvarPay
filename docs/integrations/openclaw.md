# OpenClaw: pay and get paid

**Buyer:** add the EnvarPay wallet to OpenClaw's native MCP configuration.
**Seller:** expose a dedicated native task as a private MCP tool, then price it with
EnvarPay. Your model, tools and profile stay in OpenClaw.

The [official-source Docker matrix](validation.md) includes real OpenClaw purchases
and sales. See its individual successes/failures and [source commits](../../examples/cross-framework/sources.json).
This guide does not treat an older host installation as the tested version.

## 1. Install and choose your role

Follow the [EnvarPay installation steps](../getting-started.md#install) in a separate
Python environment. Keep your existing OpenClaw installation/profile. The wallet
and payment gate use EnvarPay's environment, not the agent's dependencies.

Choose `--role buyer`, `--role seller`, or `--role both`. Both requires your own
receiving address and a separate counterparty address; see [configuration](../configuration.md).

## 2. Give OpenClaw a buyer wallet

Obtain the seller's paid MCP URL and full receiving address:

```sh
envarpay init --agent openclaw --role buyer --directory ./openclaw-pay \
  --peer-url https://seller.example/mcp --pay-to SELLER_FULL_ADDRESS \
  --max-per-call 0.01 --budget 0.05

envarpay keygen --output ./openclaw-pay/buyer.key
envarpay doctor --config ./openclaw-pay/buyer.toml
```

The generated `SETUP.md` lists your exact files and next steps. `buyer.toml` contains
the allowed recipient/tools and limits. `host-config.json` contains the native
wallet entry; no private key is embedded in that entry.

Merge **`mcp.servers.envarpay`** from `host-config.json` into **`~/.openclaw/openclaw.json` or your `OPENCLAW_CONFIG_PATH`**.
Keep all existing model/tool settings and other MCP entries. JSON also works as YAML.
Do not replace the entire host config with the snippet.

### Use a separate wallet for Docker and isolated signing

For a long-lived Agent, run `envarpay wallet-serve` in its own private service,
with `[wallet_server]` access authentication and the same persistent buyer policy,
key and ledger. Publish the wallet through authenticated HTTPS. Put this remote
MCP entry in the existing Agent profile instead of launching a local stdio signer:

```json
{
  "mcp": {
    "servers": {
      "envarpay": {
        "transport": "streamable-http",
        "url": "https://YOUR_PRIVATE_WALLET/mcp",
        "headers": {"Authorization": "Bearer YOUR_PRIVATE_WALLET_ACCESS_TOKEN"},
        "enabled": true,
        "connectionTimeoutMs": 30000,
        "requestTimeoutMs": 750000,
        "toolFilter": {"include": ["list_paid_tools", "call_paid_tool", "payment_status", "recover_payment"]}
      }
    }
  }
}
```

The access token is private wallet control, so keep the profile owner-only. The
Agent does not receive the wallet key or ledger. In a private Docker network,
use the wallet's service name and explicit HTTP allowance; expose no public
unauthenticated signer. Mount private files with the wallet UID's ownership
(UID 10001 in the released image), including the parent directories. Do not make
secret files world-readable to solve bind-mount permissions. Retain the original
ledger when changing transport. [Connection guide](../envar.md) ·
[Container ownership](../container.md) · [a11 native payment evidence](validation.md).

## 3. Check the connection before enabling payment

```sh
openclaw mcp doctor envarpay --probe
```

Inspect the selected agent's tool permissions if the MCP tools are connected but
hidden. The current native bridge may show `tool_search`, `tool_describe` and
`tool_call` around the actual `envarpay__call_paid_tool`; that is the host's dispatch layer.

You should see `list_paid_tools`, `call_paid_tool`, `payment_status` and `recover_payment` (the host
may add an MCP prefix). A connected tool is a setup check, not a payment.

Fund the generated buyer address with **Base Sepolia test USDC**. Review the chain,
USDC contract, exact seller address, tools and limits in `buyer.toml`, then set
`payments_enabled = true`. Keep the key file private and the state directory intact.

## 4. Make an explicit purchase

Ask OpenClaw to call the configured seller's `ask_agent` through `call_paid_tool`,
with the task in `arguments.question` and a stable request ID such as `review-001`.
Ask it to stop on any error or uncertainty. You can inspect the same attempt with:

```sh
envarpay status --config ./openclaw-pay/buyer.toml --operation-id buy:review-001
```

The wallet enforces the recipient/tool allowlist and both budgets. The model cannot
supply a different arbitrary URL. Reusing a completed ID returns the saved result;
an unresolved ID must not be replaced to force another purchase.

## 5. Let OpenClaw receive payment

First start a private MCP capability. The [native CLI Docker recipe](../selling.md#native-cli-seller-in-docker)
uses the real OpenClaw runtime with a dedicated profile. The
[recorded seller profile](../../examples/cross-framework/profiles/openclaw/seller/)
is a starting point to review for your own model/provider. It is not an auto-import
of your personal session.

Once the private `ask_agent` MCP endpoint is running:

```sh
envarpay init --agent openclaw --role seller --directory ./openclaw-seller \
  --pay-to YOUR_FULL_RECEIVING_ADDRESS \
  --upstream http://127.0.0.1:8000/mcp --tool ask_agent --price 0.01

envarpay doctor --config ./openclaw-seller/seller.toml
envarpay serve --config ./openclaw-seller/seller.toml
```

This example assumes a loopback upstream. In Docker, use the private runtime
hostname and follow the recipe's explicit HTTP, bind and host-allowlist settings.
Publish only the gate (`/mcp`, default port 4020) through HTTPS. The seller needs
its receiving address, not its private key. A correct Transfer/nonce receipt is
required before the native task starts.

## Troubleshooting

| Symptom | Check |
|---|---|
| MCP tools connected but unavailable to the agent | Inspect the selected tool profile/allowlist and the generated `toolFilter` |
| Config rejects `agents.list` or `agents.defaults.memorySearch` | Current main uses `agents.entries` and `memory.search`; see the recorded native profile |
| Workspace initialization guard refuses a restarted container | Persist the profile **and** workspace (`/runtime-home/workspace` in the example); do not delete guards |
| An older CLI lacks MCP doctor/probe | Use the documented current source/version; an old host install is not the tested runtime |
| Wallet says payments disabled | Complete the funding/policy review, then explicitly enable the dedicated buyer config |
| Uncertain payment or execution | Preserve the original ID/authorization/state; inspect status before any new purchase |

## Optional: existing Gateway HTTP service (experimental)

**Experimental source-preview connector; Gateway HTTP paid acceptance is pending; the native MCP/CLI matrix does not cover it.**

Enable `gateway.http.endpoints.responses.enabled` on a dedicated Gateway. Create/select the fixed seller agent ID (the generated target is `openclaw/seller`).

```sh
envarpay init --role seller --directory ./agent-pay --pay-to YOUR_FULL_ADDRESS --backend openclaw
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


[All agents](index.md) · [Configuration reference](../configuration.md) · [Payment evidence](validation.md)

Optional: [original-operation recovery, directory discovery and remote wallet isolation](../directory-and-recovery.md). Recovery can resume an already-paid task that never started; it does not create a fresh signature.
