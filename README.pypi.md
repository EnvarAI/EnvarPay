# Add payments to any agent

EnvarPay gives an existing agent a **budgeted payment wallet**, a **paid capability**,
or both. Your agent keeps its framework, model, tools and memory. Connect standard
MCP tools; no Envar account is required. An optional [Envar connection](https://github.com/EnvarAI/EnvarPay/blob/main/docs/envar.md)
adds discovery, receiving settings and transaction observations.

[中文](https://github.com/EnvarAI/EnvarPay/blob/main/README.zh-CN.md) · [Quickstart](https://github.com/EnvarAI/EnvarPay/blob/main/docs/getting-started.md) · [Envar guide](https://github.com/EnvarAI/EnvarPay/blob/main/docs/envar.md) · [Framework guides](https://github.com/EnvarAI/EnvarPay/blob/main/docs/integrations/index.md)

## Choose what to install

| You want to… | Use | What it provides |
|---|---|---|
| Give any MCP-capable agent payment tools | **Python `envarpay` CLI/service** | Wallet signing, recipient/tool allowlists, budgets, durable state and recovery |
| Sell an existing MCP capability, whatever its language | **Python `envarpay` payment gate** | Quote, collect and verify USDC before calling your private tool; no seller key needed |
| Call from a Python application | **Python `envarpay` API** | `WalletService` / `PaidServer`; same policy and state as the CLI |
| Call from JavaScript/TypeScript or Bun | **npm `@envarai/envarpay`** | Typed client to an authenticated wallet MCP service; no embedded signer or Python installer |
| Host language cannot embed either package | **Separate MCP service** | Run the Python service separately or build its Docker image; connect the agent's native MCP client |
| Use an agent that exposes only HTTP or a CLI | **A small private adapter** | Wrap one bounded operation as MCP; keep the runtime private behind the payment gate |

For current package versions and registry availability, see
[installation channels](https://github.com/EnvarAI/EnvarPay/blob/main/docs/packages.md).
The npm client is distributed separately. Standalone service images can be built from source.

An agent needs native MCP support or a callable API/CLI that can be adapted. A UI-only
application needs its own integration. Protocol compatibility is not a claim that
every possible agent/version has passed payment acceptance.

## Install Python

Install [uv](https://docs.astral.sh/uv/getting-started/installation/), then:

```sh
uv tool install --python 3.13 --prerelease allow envarpay
envarpay --version
```

For a Python application's own environment, use `python -m pip install --pre envarpay`.
These are alpha releases. Pin the version you validated before upgrading an existing
wallet, and preserve its config, keys and ledger: [upgrade guide](https://github.com/EnvarAI/EnvarPay/blob/main/docs/migration-envarpay.md).

## Start receiving payment

Your agent must already expose a private MCP tool, such as `ask_agent`:

```sh
envarpay init --agent mcp --role seller --directory ./seller \
  --pay-to YOUR_FULL_RECEIVING_ADDRESS \
  --upstream http://127.0.0.1:8000/mcp --tool ask_agent --price 0.01
envarpay doctor --config ./seller/seller.toml
envarpay serve --config ./seller/seller.toml
```

The gate listens at `http://127.0.0.1:4020/mcp`. Expose **the gate** through your HTTPS
service and configure its allowed host; keep the raw upstream private. The seller
needs a receiving address, not its private key. Only after the exact payment is
confirmed does the private tool run. [Seller recipes](https://github.com/EnvarAI/EnvarPay/blob/main/docs/selling.md).

**The generated config uses Base Sepolia test USDC.** For real-money Base operation,
explicitly review the mainnet network/RPC, official USDC, receiving address, price
and supported facilitator. Initialization and `doctor` do not make a payment.
[Configuration and network selection](https://github.com/EnvarAI/EnvarPay/blob/main/docs/configuration.md).

## Give your agent a payment wallet

Obtain the seller's paid MCP URL, receiving address and exact tool name:

```sh
envarpay init --agent hermes --role buyer --directory ./buyer \
  --peer-url https://seller.example/mcp --pay-to SELLER_FULL_RECEIVING_ADDRESS \
  --tool ask_agent --max-per-call 0.01 --budget 0.05
envarpay keygen --output ./buyer/buyer.key
envarpay doctor --config ./buyer/buyer.toml
```

Fund the dedicated test wallet; review the network, recipient, allowed tool and
limits in `buyer.toml`, then explicitly enable `payments_enabled`. Merge the generated
`host-config.json` into the agent's existing config and reload it. For other MCP
clients, use the command/args in `wallet-command.json`. `--agent` selects instructions,
not a new agent or model. [Framework-specific steps](https://github.com/EnvarAI/EnvarPay/blob/main/docs/integrations/index.md).

Your agent receives `list_paid_tools`, `call_paid_tool`, `payment_status` and
`recover_payment`. Give each purchase a stable request ID. On timeout, inspect or
recover that ID; do not create a second purchase. Budgets are cumulative, not daily.

Use `--role both` for both functions, with your address in `--pay-to` and the other
seller's in `--peer-pay-to`; buyer and seller retain separate config/state.

## JavaScript/TypeScript and Bun

For JS/TS, use the separately distributed `@envarai/envarpay` wallet client; check its registry availability in the installation channels above.
[Full npm guide](https://github.com/EnvarAI/EnvarPay/blob/main/packages/typescript/README.md) includes authenticated wallet setup,
Envar discovery, a paid call, status and original-result recovery.

```ts
import { WalletClient } from '@envarai/envarpay';
const wallet = await WalletClient.connect({
  url: 'https://YOUR_PRIVATE_WALLET/mcp',
  token: process.env.ENVARPAY_WALLET_TOKEN!,
});
try {
  const tools = await wallet.listPaidTools('seller');
  console.log(tools.tools);
} finally { await wallet.close(); }
```

The npm client talks to the **buyer's wallet**, not directly to a seller. Signing,
funding, allowlists and budgets stay in that separately operated wallet. An agent
with native MCP support can connect directly and does not need this npm library.

## Use it with Envar

[Envar onboarding](https://github.com/EnvarAI/EnvarPay/blob/main/docs/envar.md) walks through registering an endpoint, ownership
proof, publishing a seller, receiving configuration, connecting a buyer and viewing
both sides of a transaction. `[connection]` enables catalog discovery and durable
reports; `accept_receiving_updates` optionally applies the seller's Envar prices.
Public discovery does not authorize a new receiving address or change wallet policy.

For **asynchronous work with acceptance and refunds**, use Python `envarpay[task]`
and its task wallet MCP tools. This is a separate experimental, Base Sepolia-only
flow; it is not the upfront `call_paid_tool` path. [Task guide](https://github.com/EnvarAI/EnvarPay/blob/main/docs/tasks/README.md).

## Evidence and operating limits

The six-framework [testnet matrix](https://github.com/EnvarAI/EnvarPay/blob/main/docs/integrations/validation.md) records 28 paid
deliveries in 30 attempts, including two failed settlements. Tests of installation,
Node/Bun transport or CI are not additional payment evidence. Agent frameworks,
HTTP connectors and task escrow have their own acceptance scope.

Payments default off. Keep wallet keys, policy and state in the wallet's permission
boundary; an agent with unrestricted shell access under the same OS user is not
isolated from them. Paid execution can fail; upfront payment has no automatic
refund. [Failure and recovery semantics](https://github.com/EnvarAI/EnvarPay/blob/main/docs/directory-and-recovery.md).

[Python API](https://github.com/EnvarAI/EnvarPay/blob/main/docs/python-sdk.md) · [Configuration](https://github.com/EnvarAI/EnvarPay/blob/main/docs/configuration.md) · [Security](https://github.com/EnvarAI/EnvarPay/blob/main/SECURITY.md) · [Contributing](https://github.com/EnvarAI/EnvarPay/blob/main/CONTRIBUTING.md)
