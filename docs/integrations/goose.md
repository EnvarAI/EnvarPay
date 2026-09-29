# Goose: pay and get paid

**Buyer:** add the EnvarPay wallet to Goose's native MCP configuration.
**Seller:** expose a dedicated native task as a private MCP tool, then price it with
EnvarPay. Your model, tools and profile stay in Goose.

The [official-source Docker matrix](validation.md) includes real Goose purchases
and sales. See its individual successes/failures and [source commits](../../examples/cross-framework/sources.json).
This guide does not treat an older host installation as the tested version.

## 1. Install and choose your role

Follow the [EnvarPay installation steps](../getting-started.md#install) in a separate
Python environment. Keep your existing Goose installation/profile. The wallet
and payment gate use EnvarPay's environment, not the agent's dependencies.

Choose `--role buyer`, `--role seller`, or `--role both`. Both requires your own
receiving address and a separate counterparty address; see [configuration](../configuration.md).

## 2. Give Goose a buyer wallet

Obtain the seller's paid MCP URL and full receiving address:

```sh
envarpay init --agent goose --role buyer --directory ./goose-pay \
  --peer-url https://seller.example/mcp --pay-to SELLER_FULL_ADDRESS \
  --max-per-call 0.01 --budget 0.05

envarpay keygen --output ./goose-pay/buyer.key
envarpay doctor --config ./goose-pay/buyer.toml
```

The generated `SETUP.md` lists your exact files and next steps. `buyer.toml` contains
the allowed recipient/tools and limits. `host-config.json` contains the native
wallet entry; no private key is embedded in that entry.

Merge **`extensions.envarpay`** from `host-config.json` into **`~/.config/goose/config.yaml`, honoring `XDG_CONFIG_HOME`**.
Keep all existing model/tool settings and other MCP entries. JSON also works as YAML.
Do not replace the entire host config with the snippet.

## 3. Check the connection before enabling payment

In Goose Desktop, the equivalent entry is **Extensions → STDIO**, using the
executable and arguments from the generated file. In headless mode, enable the
extension in the selected config and ask Goose to call `payment_status` for
`setup-check-never-paid`. Keep payments off during this connection check.

Goose's extension `timeout` is in **seconds**; do not copy OpenCode's millisecond value.

You should see `list_paid_tools`, `call_paid_tool`, `payment_status` and `recover_payment` (the host
may add an MCP prefix). A connected tool is a setup check, not a payment.

Fund the generated buyer address with **Base Sepolia test USDC**. Review the chain,
USDC contract, exact seller address, tools and limits in `buyer.toml`, then set
`payments_enabled = true`. Keep the key file private and the state directory intact.

## 4. Make an explicit purchase

Ask Goose to call the configured seller's `ask_agent` through `call_paid_tool`,
with the task in `arguments.question` and a stable request ID such as `review-001`.
Ask it to stop on any error or uncertainty. You can inspect the same attempt with:

```sh
envarpay status --config ./goose-pay/buyer.toml --operation-id buy:review-001
```

The wallet enforces the recipient/tool allowlist and both budgets. The model cannot
supply a different arbitrary URL. Reusing a completed ID returns the saved result;
an unresolved ID must not be replaced to force another purchase.

## 5. Let Goose receive payment

First start a private MCP capability. The [native CLI Docker recipe](../selling.md#native-cli-seller-in-docker)
uses the real Goose runtime with a dedicated profile. The
[recorded seller profile](../../examples/cross-framework/profiles/goose/seller/)
is a starting point to review for your own model/provider. It is not an auto-import
of your personal session.

Once the private `ask_agent` MCP endpoint is running:

```sh
envarpay init --agent goose --role seller --directory ./goose-seller \
  --pay-to YOUR_FULL_RECEIVING_ADDRESS \
  --upstream http://127.0.0.1:8000/mcp --tool ask_agent --price 0.01

envarpay doctor --config ./goose-seller/seller.toml
envarpay serve --config ./goose-seller/seller.toml
```

This example assumes a loopback upstream. In Docker, use the private runtime
hostname and follow the recipe's explicit HTTP, bind and host-allowlist settings.
Publish only the gate (`/mcp`, default port 4020) through HTTPS. The seller needs
its receiving address, not its private key. A correct Transfer/nonce receipt is
required before the native task starts.

## Troubleshooting

| Symptom | Check |
|---|---|
| Extension is not visible | Check `enabled: true`, `type: stdio` and the actual XDG/profile config path |
| Wrong executable or arguments | `cmd` is the generated absolute Python path; `args` includes `-m envarpay wallet --config ...` |
| Headless run uses the wrong model endpoint | Review `OPENAI_BASE_URL` and the provider's model/key settings |
| Confusion between Goose SDK and the full agent | `goose-sdk` provider bindings do not by themselves supply the full agent/tool/session loop |
| Wallet says payments disabled | Complete the funding/policy review, then explicitly enable the dedicated buyer config |
| Uncertain payment or execution | Preserve the original ID/authorization/state; inspect status before any new purchase |

## SDK scope

The Goose provider SDK is useful for model completion/streaming, but does not by
itself replace the full Goose agent. The paid matrix invoked `goose run --no-session
--output-format json` with the real native extension/tool loop.

Sources: [STDIO extensions](https://github.com/aaif-goose/goose/blob/b92a80daf4a77d7e854709965bdfdc489c0472d2/documentation/docs/tutorials/custom-extensions.md),
[headless Goose](https://github.com/aaif-goose/goose/blob/b92a80daf4a77d7e854709965bdfdc489c0472d2/documentation/docs/tutorials/headless-goose.md).


[All agents](index.md) · [Configuration reference](../configuration.md) · [Payment evidence](validation.md)

Optional: [original-operation recovery, directory discovery and remote wallet isolation](../directory-and-recovery.md). Recovery can resume an already-paid task that never started; it does not create a fresh signature.
