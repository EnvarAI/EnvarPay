<p align="center">
  <img src="assets/banner.svg" alt="EnvarPay — Get your agents paid" width="100%" />
</p>

<p align="center">
  <a href="https://github.com/EnvarAI/EnvarPay/actions/workflows/ci.yml"><img src="https://github.com/EnvarAI/EnvarPay/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license" /></a>
  <img src="https://img.shields.io/badge/Python-3.11%2B-blue.svg" alt="Python 3.11+" />
  <a href="https://github.com/EnvarAI/EnvarPay/releases"><img src="https://img.shields.io/badge/status-alpha-orange.svg" alt="Alpha" /></a>
</p>

<p align="center"><strong>Sell agent capabilities. Pay for other agents. Keep your runtime.</strong></p>
<p align="center"><a href="README.zh-CN.md">中文</a> · <a href="docs/getting-started.md">Get started</a> · <a href="docs/python-sdk.md">Python SDK</a> · <a href="docs/proof-of-concept.md">Real payment POC</a></p>

## Add payments to the agent you already use

**EnvarPay** is a Python SDK and CLI for adding two capabilities to an agent:
**pay another agent within a budget**, and **charge for a capability before running it**.
It uses official **MCP + x402 v2** SDKs and USDC. Your agent keeps its own framework,
model and tools; you do not need an Envar account or an Envar-hosted runtime.

| Your agent | Pay other agents | Receive payment | Full guide |
|---|---|---|---|
| **OpenClaw** | Native MCP wallet entry | Private native CLI/MCP adapter + payment gate | [OpenClaw](docs/integrations/openclaw.md) |
| **Hermes** | Native MCP wallet entry | Private native CLI/MCP adapter + payment gate | [Hermes](docs/integrations/hermes.md) |
| **OpenCode** | Native local MCP entry | Private native CLI/MCP adapter + payment gate | [OpenCode](docs/integrations/opencode.md) |
| **Goose** | Native STDIO extension | Private headless MCP adapter + payment gate | [Goose](docs/integrations/goose.md) |
| **LangGraph / LangChain** | Official `MCPAdapter` | Wrap your graph/agent as a private MCP tool | [LangGraph](docs/integrations/langgraph.md) |
| **Pydantic AI** | Official `MCPToolset` | Wrap `Agent.run()` as a private MCP tool | [Pydantic AI](docs/integrations/pydantic-ai.md) |
| **Any MCP client/service** | Launch the wallet MCP process | Price selected existing MCP tools | [Generic MCP](docs/integrations/index.md) |

All six named runtimes have made and received real testnet payments in local Docker:
**28 of 30 directed purchases delivered successfully**, with two failed settlements
preserved in the [transaction matrix](docs/integrations/validation.md). This is
validation of the listed native MCP paths. Existing OpenClaw/Hermes Gateway HTTP
connectors are experimental and have separate acceptance work remaining.

## Install

Python 3.11+. Install EnvarPay in its own environment:

```sh
git clone https://github.com/EnvarAI/EnvarPay.git
cd EnvarPay
python3 -m venv .venv
source .venv/bin/activate
python -m pip install .
envarpay --help
```

Package, command and Python import are all **`envarpay`**. Source preview `0.1.0a5`
is not on PyPI yet. The published GitHub prerelease is `0.1.0a3`; the new onboarding commands here
are in the `0.1.0a5` source. See
[migration instructions](docs/migration-envarpay.md) if you already have a wallet.

## I want my agent to pay others

You need the seller's **paid MCP URL**, **full receiving address** and tool name.
This example gives Hermes a wallet; change `--agent` for another framework.

```sh
envarpay init --agent hermes --role buyer --directory ./my-wallet \
  --peer-url https://seller.example/mcp --pay-to SELLER_FULL_WALLET_ADDRESS \
  --max-per-call 0.01 --budget 0.05
```

The command writes `buyer.toml`, `host-config.json`, `wallet-command.json` and a
personalized `SETUP.md`. The output shows the chain, full recipient and limits.
It creates no private key and makes no payment.

1. Run `envarpay keygen --output ./my-wallet/buyer.key`; fund that dedicated address with **Base Sepolia test USDC**.
2. Review `buyer.toml`, then explicitly set `payments_enabled = true`.
3. Merge the generated `host-config.json` entry into your existing agent configuration and reload the agent. Python frameworks use `wallet-command.json` with their official adapter instead.
4. Run `envarpay doctor --config ./my-wallet/buyer.toml` to inspect the effective configuration.

Your agent gets four core tools:

| Tool | Agent capability |
|---|---|
| `list_paid_tools` | Discover allowed tools at an operator-configured seller |
| `call_paid_tool` | Call a tool and pay within the recipient/tool allowlist and budget |
| `payment_status` | Inspect an existing attempt without signing again |
| `recover_payment` | Recover an original authorized operation/result with an approved recovery-capable seller |

Ask your agent to call the seller using a stable request ID, for example
`review-001`. Reuse that ID for the same purchase; preserve state on uncertainty.
[Complete buyer walkthrough →](docs/getting-started.md#pay-for-a-capability)

## I want my agent to receive payment

You need your **receiving address**, a **private MCP capability** and its price.
If your agent does not expose MCP, use the native or Python adapter in its guide
above. Selecting `--agent` chooses the guide/client configuration; it does not
install an agent or automatically expose its personal session.

```sh
envarpay init --agent hermes --role seller --directory ./my-service \
  --pay-to YOUR_FULL_WALLET_ADDRESS \
  --upstream http://127.0.0.1:8000/mcp --tool ask_agent --price 0.01

envarpay doctor --config ./my-service/seller.toml
envarpay serve --config ./my-service/seller.toml
```

Expose the payment gate at `http://127.0.0.1:4020/mcp` through your HTTPS service.
Keep the raw upstream private. The seller needs **only its receiving address**,
not its private key. `doctor` checks configuration; it does not claim a live delivery.

```mermaid
sequenceDiagram
    participant B as Buyer agent
    participant W as EnvarPay wallet
    participant G as EnvarPay payment gate
    participant A as Seller's private agent/tool
    B->>W: Call a paid tool
    W->>G: Request capability
    G-->>W: x402 PaymentRequired + price
    W->>W: Check recipient and budget; sign
    W->>G: Request + original authorization
    G->>G: Settle; verify exact USDC transfer + nonce
    G->>A: Execute after payment confirmation
    A-->>B: Deliver result through EnvarPay
```

[Complete seller walkthrough →](docs/getting-started.md#charge-for-a-capability)

## Both capabilities, one agent

Keep your receiving address and the other seller's address separate:

```sh
envarpay init --agent openclaw --role both --directory ./agent-pay \
  --pay-to YOUR_FULL_WALLET_ADDRESS --price 0.01 \
  --upstream http://127.0.0.1:8000/mcp \
  --peer-url https://other-seller.example/mcp --peer-pay-to OTHER_SELLER_ADDRESS \
  --max-per-call 0.01 --budget 0.05
```

This generates independent buyer/seller configs and state paths. Start the seller
gate and connect the wallet using the generated instructions. Model configuration
stays in your original runtime.

For private authenticated interaction without payments, use `--mode private`
with an existing MCP/HTTP service. [Private service setup](docs/getting-started.md#connect-a-private-existing-service).

## Configuration at a glance

| What you choose | CLI option | Saved setting |
|---|---|---|
| Agent and capability | `--agent`, `--role buyer/seller/both` | Relevant files + framework guide |
| Seller receiving address | `--pay-to` / `--peer-pay-to` | Exact recipient allowlist |
| Capability to sell | `--upstream`, `--tool` | Private MCP endpoint and priced tool |
| Seller price | `--price 0.01` | `amount_atomic = 10000` |
| Buyer limits | `--max-per-call 0.01 --budget 0.05` | 10000 per call; 50000 cumulative atomic units |
| Payment enablement | Review `buyer.toml` | `payments_enabled = false` by default |

CLI amounts are **USDC**, with up to six decimal places; conversion to atomic
units is exact. Budgets persist across restarts. `init` refuses to overwrite a
nonempty directory or edit personal agent profiles. [Full configuration reference →](docs/configuration.md)

## Use the Python SDK

```python
from pathlib import Path
from envarpay import WalletService, load_config

wallet = WalletService(load_config(Path("my-wallet/buyer.toml")))
result = await wallet.call(
    "seller", "ask_agent", {"question": "Review these notes"}, "review-001"
)
```

The SDK and CLI use the same policy and ledger. [Python API](docs/python-sdk.md) ·
[Portable framework example](examples/integrations/python_agents.py) ·
[Native Docker examples](examples/cross-framework/README.md)

## Scope and evidence

EnvarPay is an independent **alpha** adapter, not a new protocol or an official
release of the supported frameworks. MCP handles tools; x402 v2 handles payments;
EnvarPay supplies policy, persistence and receipt-before-execution checks.

The [testnet matrix](docs/integrations/validation.md) includes actual transactions,
native agent results, original nonces, source SHAs and Docker image IDs. CI,
configuration checks and offline signatures are not payment evidence. This
onboarding update itself does not claim new payments or 30/30 acceptance.

Defaults use Base Sepolia, payments off and a 0.01-USDC per-call/total budget.
An optional Envar connection adds directory discovery and durable reporting; directory
results never grant spending authority. Original-operation recovery requires an
approved recovery-capable seller. [Directory and recovery guide](docs/directory-and-recovery.md).
Mainnet readiness, refunds, custody guarantees, generic A2A orchestration and
delivery-quality guarantees are outside this alpha.
Read the [payment and failure semantics](docs/getting-started.md#payment-and-failure-semantics).

[Contribute](CONTRIBUTING.md) · [Report a security issue privately](https://github.com/EnvarAI/EnvarPay/security/advisories/new) · [MIT license](LICENSE)
