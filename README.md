<p align="center">
  <img src="assets/banner.svg" alt="EnvarPay — Get your agents paid" width="100%" />
</p>

<p align="center">
  <a href="https://github.com/EnvarAI/EnvarPay/actions/workflows/ci.yml?query=branch%3Amain"><img src="https://github.com/EnvarAI/EnvarPay/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI status on main" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/EnvarAI/EnvarPay" alt="License" /></a>
  <a href="pyproject.toml"><img src="https://img.shields.io/badge/python-3.11%2B-blue?logo=python&amp;logoColor=white" alt="Requires Python 3.11+" /></a>
  <a href="https://github.com/EnvarAI/EnvarPay/releases"><img src="https://img.shields.io/github/v/release/EnvarAI/EnvarPay?include_prereleases&amp;label=release" alt="Latest GitHub release, including prereleases" /></a>
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

The current CLI is a Python distribution that **any MCP-capable agent can use**.
With [uv](https://docs.astral.sh/uv/getting-started/installation/) installed, install
the source preview into a persistent isolated tool environment:

```sh
uv tool install --python 3.13 'git+https://github.com/EnvarAI/EnvarPay.git@f794729106d1c80543e179c395899c497c6e01f0'
envarpay --version
```

This pins the reviewed security baseline `0.1.0a5`; it is not a PyPI install.
The distribution preparation in this branch targets unreleased `0.1.0a6`. Registry checks on
2026-09-30 found no `envarpay` project on PyPI or npm. The existing GitHub prerelease
is `0.1.0a3`. We do not advertise `pip install envarpay` or `npm install envarpay`
as working commands before those packages actually exist.

A standalone service [Dockerfile](Dockerfile) is also provided for hosts that do
not want to install Python. The npm TypeScript client and framework-native plugins
are proposed, not shipped. [Packages, languages and publishing status →](docs/packages.md)

For Python API development or contributing, use the [development install](CONTRIBUTING.md).
Existing wallets should follow [migration instructions](docs/migration-envarpay.md),
keeping the original key, config and ledger paths.

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

![Agent payment flow](assets/payment-flow.svg)

[Diagram source](assets/payment-flow.mmd)

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

## Experimental task escrow

The task escrow candidate is documented in [docs/tasks](docs/tasks/README.md).
It is separate from prepaid x402 calls and is not mainnet-ready. Public testnet
acceptance is pending; previous POC results do not certify this candidate.
