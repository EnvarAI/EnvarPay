# OpenCode: pay and get paid

**Buyer:** add the EnvarPay wallet to OpenCode's native MCP configuration.
**Seller:** expose a dedicated native task as a private MCP tool, then price it with
EnvarPay. Your model, tools and profile stay in OpenCode.

The [official-source Docker matrix](validation.md) includes real OpenCode purchases
and sales. See its individual successes/failures and [source commits](../../examples/cross-framework/sources.json).
This guide does not treat an older host installation as the tested version.

## 1. Install and choose your role

Follow the [EnvarPay installation steps](../getting-started.md#install) in a separate
Python environment. Keep your existing OpenCode installation/profile. The wallet
and payment gate use EnvarPay's environment, not the agent's dependencies.

Choose `--role buyer`, `--role seller`, or `--role both`. Both requires your own
receiving address and a separate counterparty address; see [configuration](../configuration.md).

## 2. Give OpenCode a buyer wallet

Obtain the seller's paid MCP URL and full receiving address:

```sh
envarpay init --agent opencode --role buyer --directory ./opencode-pay \
  --peer-url https://seller.example/mcp --pay-to SELLER_FULL_ADDRESS \
  --max-per-call 0.01 --budget 0.05

envarpay keygen --output ./opencode-pay/buyer.key
envarpay doctor --config ./opencode-pay/buyer.toml
```

The generated `SETUP.md` lists your exact files and next steps. `buyer.toml` contains
the allowed recipient/tools and limits. `host-config.json` contains the native
wallet entry; no private key is embedded in that entry.

Merge **`mcp.envarpay`** from `host-config.json` into **project `opencode.json`, or the configuration selected through `OPENCODE_CONFIG`**.
Keep all existing model/tool settings and other MCP entries. JSON also works as YAML.
Do not replace the entire host config with the snippet.

## 3. Check the connection before enabling payment

```sh
opencode --pure mcp list
```

The generated entry uses `type: local`, a command array, `enabled: true` and a
request timeout in **milliseconds**. The payment/confirmation/execution request
needs more time than a normal small utility tool call.

You should see `list_paid_tools`, `call_paid_tool`, `payment_status` and `recover_payment` (the host
may add an MCP prefix). A connected tool is a setup check, not a payment.

Fund the generated buyer address with **Base Sepolia test USDC**. Review the chain,
USDC contract, exact seller address, tools and limits in `buyer.toml`, then set
`payments_enabled = true`. Keep the key file private and the state directory intact.

## 4. Make an explicit purchase

Ask OpenCode to call the configured seller's `ask_agent` through `call_paid_tool`,
with the task in `arguments.question` and a stable request ID such as `review-001`.
Ask it to stop on any error or uncertainty. You can inspect the same attempt with:

```sh
envarpay status --config ./opencode-pay/buyer.toml --operation-id buy:review-001
```

The wallet enforces the recipient/tool allowlist and both budgets. The model cannot
supply a different arbitrary URL. Reusing a completed ID returns the saved result;
an unresolved ID must not be replaced to force another purchase.

## 5. Let OpenCode receive payment

First start a private MCP capability. The [native CLI Docker recipe](../selling.md#native-cli-seller-in-docker)
uses the real OpenCode runtime with a dedicated profile. The
[recorded seller profile](../../examples/cross-framework/profiles/opencode/seller/)
is a starting point to review for your own model/provider. It is not an auto-import
of your personal session.

Once the private `ask_agent` MCP endpoint is running:

```sh
envarpay init --agent opencode --role seller --directory ./opencode-seller \
  --pay-to YOUR_FULL_RECEIVING_ADDRESS \
  --upstream http://127.0.0.1:8000/mcp --tool ask_agent --price 0.01

envarpay doctor --config ./opencode-seller/seller.toml
envarpay serve --config ./opencode-seller/seller.toml
```

This example assumes a loopback upstream. In Docker, use the private runtime
hostname and follow the recipe's explicit HTTP, bind and host-allowlist settings.
Publish only the gate (`/mcp`, default port 4020) through HTTPS. The seller needs
its receiving address, not its private key. A correct Transfer/nonce receipt is
required before the native task starts.

## Troubleshooting

| Symptom | Check |
|---|---|
| MCP process immediately exits | Check that the absolute EnvarPay interpreter and buyer config exist |
| Model sees no wallet tool | Review OpenCode's permission rules for `envarpay_*` tools |
| Request times out during payment/execution | Preserve the request ID/state; use the generated request timeout, not a short generic MCP timeout |
| Native server SDK behaves differently | The tested seller uses native CLI; an existing `@opencode-ai/sdk` session connector has separate integration work |
| Wallet says payments disabled | Complete the funding/policy review, then explicitly enable the dedicated buyer config |
| Uncertain payment or execution | Preserve the original ID/authorization/state; inspect status before any new purchase |

## Existing OpenCode server

The official `@opencode-ai/sdk` exposes server/session APIs. The native paid matrix
uses `opencode --pure run --format json` behind MCP; it does not validate attaching
the payment gate to an existing interactive session through the JS SDK.

Sources: [official MCP guide](https://opencode.ai/docs/mcp-servers/),
[SDK](https://opencode.ai/docs/sdk/), [server](https://opencode.ai/docs/server/).


[All agents](index.md) · [Configuration reference](../configuration.md) · [Payment evidence](validation.md)

Optional: [original-operation recovery, directory discovery and remote wallet isolation](../directory-and-recovery.md). Recovery can resume an already-paid task that never started; it does not create a fresh signature.
