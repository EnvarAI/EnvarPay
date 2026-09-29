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

### Start with the agent you use

[OpenClaw](docs/integrations/openclaw.md) · [Hermes](docs/integrations/hermes.md) ·
[OpenCode](docs/integrations/other-runtimes.md#opencode) ·
[Goose](docs/integrations/other-runtimes.md#goose) ·
[Build with a framework](docs/integrations/other-runtimes.md#langgraph-and-langchain)

Read the [support matrix](docs/integrations/index.md) before choosing an adapter:
validation is version-specific. Six native runtimes have now made and received
real Base Sepolia payments in local Docker. The [transaction matrix](docs/integrations/validation.md)
records successful deliveries and failed settlements separately.

**EnvarPay** is an open-source Python SDK and CLI that connects agents to
**MCP + x402 v2** payments. Put a USDC payment gate in front of an existing MCP
tool, and give buyers a wallet tool with an explicit spending budget.
It works with an agent framework through that framework's own MCP client and runtime.

### Two sides. One package.

| | Command | What it does |
|---|---|---|
| **Get paid** | `envarpay serve` | Quote a price, confirm payment, then execute your agent's capability. |
| **Pay others** | `envarpay wallet` | Give an MCP-capable agent a payment tool constrained by your allowlist and budget. |

```mermaid
sequenceDiagram
    participant B as Buyer agent
    participant W as EnvarPay wallet
    participant S as EnvarPay seller
    participant F as x402 facilitator / USDC
    participant A as Your agent or MCP tool
    B->>W: Call a paid capability
    W->>S: MCP tool call
    S-->>W: PaymentRequired + price
    W->>W: Check recipient and budget; sign
    W->>S: Request + x402 payment
    S->>F: Verify and settle
    F-->>S: Transaction receipt
    S->>S: Verify Transfer + authorization nonce
    S->>A: Execute after payment
    A-->>B: Deliver result through EnvarPay
```

### Why EnvarPay?

- **Keep your framework.** Connect existing MCP tools or a native Hermes/OpenClaw HTTP service. Models and tools remain in your runtime; EnvarPay does not instantiate an embedded Agent.
- **Use open protocols.** Official MCP and x402 SDKs handle the wire format. No Envar account or proprietary settlement API is required.
- **Pay first, work second.** The seller checks the exact USDC transfer and nonce before running the paid capability.
- **Put spending limits in code.** Configure allowed services, full recipients, tools, per-call limits and a persistent cumulative budget.
- **Keep uncertain payments visible.** Save the original authorization; reuse request IDs and inspect unresolved attempts without signing again.

### Install

Python 3.11+, tested on macOS and Linux. Native Windows permissions are not yet validated; use WSL or Docker.

```bash
git clone https://github.com/EnvarAI/EnvarPay.git
cd EnvarPay
python -m pip install .
envarpay --help
```

This alpha is not on PyPI yet. The existing [GitHub release](https://github.com/EnvarAI/EnvarPay/releases)
is 0.1.0a1 with the old package name. See [upgrade instructions](docs/migration-envarpay.md).
EnvarPay runs in its own Python environment; the existing Agent keeps its model, tools and configuration.

### Start receiving payments

```bash
envarpay init --directory ./agent-pay --pay-to YOUR_WALLET_ADDRESS --backend mcp
# Set seller.backend.upstream to your private MCP service.
# Set the tool name and price under seller.tools; review network and recipient.
envarpay serve --config ./agent-pay/seller.toml
```

Your paid `ask_agent` tool is available at `http://127.0.0.1:4020/mcp` (or `/sse`).
The seller needs its receiving address, not its private key.
For an agent that does not expose MCP, start with the
[native Docker adapters](examples/cross-framework/README.md): a bounded `ask_agent`
tool invokes the native CLI or framework only after the outer payment gate confirms payment.
Keep that raw MCP service private. These are examples to adapt, not a one-command
installer for an existing personal session.
The `openclaw` and `hermes-http` Gateway HTTP connectors are experimental;
their live paid acceptance is separate and remains pending.
The embedded `hermes` backend has been removed. Use `hermes-http` to connect an existing service; [private HTTP delivery is verified separately](docs/integrations/existing-runtime-validation.md).

### Give an agent a payment wallet

```bash
envarpay keygen --output ./agent-pay/buyer.key
# Fund the dedicated test wallet; review the recipient and budget in buyer.toml.
# Payments default to OFF. Enable them only after reviewing the configuration.
envarpay host-config --host hermes --config ./agent-pay/buyer.toml
```

Merge the generated `mcp_servers.envarpay` entry into Hermes's MCP configuration.
Use `--host openclaw`, `--host opencode`, or `--host goose` for those native clients.
Other MCP clients can launch the same `envarpay wallet --config ...` process.
The agent gets `list_paid_tools`, `call_paid_tool` and `payment_status`.

For a direct call:

```bash
envarpay call --config ./agent-pay/buyer.toml --peer seller --tool ask_agent \
  --arguments '{"question":"Help our team plan a weekly knowledge review"}' \
  --request-id weekly-review-001
```

For an embedded integration:

```python
from pathlib import Path
from envarpay import WalletService, load_config

wallet = WalletService(load_config(Path("agent-pay/buyer.toml")))
result = await wallet.call(
    "seller", "ask_agent", {"question": "Review these notes"}, "review-001"
)
```

### What has been proven?

The [six-framework matrix](docs/integrations/validation.md) uses official development
branches resolved to full commits on 2026-09-29, then frozen for one local Docker run.
Every successful direction has its own **0.0001 test-USDC** payment, native buyer
tool call, exact USDC Transfer and authorization nonce, seller execution after
receipt verification, delivered result, and duplicate-request replay check.
The matrix includes failed settlements; it does not claim 30/30 acceptance.

Build artifacts from CI supply dependencies and native binaries. Actual agents,
payments and deliveries run locally. The earlier [two-Hermes POC](docs/proof-of-concept.md)
is separate historical evidence. None of these tests establish mainnet readiness.

### Current scope

`0.1.0a3` is an alpha SDK with explicit payment policies and durable recovery. Defaults use Base
Sepolia, payments off, and a 0.01 test-USDC per-call and cumulative budget.

| Included | Not yet included |
|---|---|
| MCP Streamable HTTP, SSE and stdio adapters | Agent discovery marketplace and A2A tasks |
| x402 v2 exact USDC / EIP-3009, upfront flow | Automatic refunds or delivery-quality guarantees |
| Local dedicated-key signer and durable local state | Hosted custody, external signing providers, multi-host coordination |
| Duplicate-request protection and read-only receipt reconciliation | Automatic recovery of ambiguous execution or lost transaction hashes |

Base mainnet configuration exists, but this release has no new mainnet payment
validation. Preserve the state after an uncertain result: deleting it or creating
a new purchase ID can defeat your intended spending controls. A wallet component
running under the same OS identity as an agent with shell access is not isolated
from that agent. See [operating boundaries](docs/getting-started.md#payment-and-failure-semantics).

### Contribute

Try an integration, report a reproducible issue, or improve interoperability.
Start with [CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities through
[GitHub's private reporting channel](https://github.com/EnvarAI/EnvarPay/security/advisories/new).

Built with [MCP](https://github.com/modelcontextprotocol/python-sdk),
[x402](https://github.com/coinbase/x402) and optional
[Hermes](https://github.com/NousResearch/hermes-agent) integration. EnvarPay is an
independent project by [EnvarAI](https://github.com/EnvarAI), not an official
distribution or endorsement by those projects. [MIT licensed](LICENSE).

See the [current validation ledger](docs/integrations/validation.md) for actual host versions, failed prerequisites and remaining acceptance checks.

Directory and durable recovery: [operator guide](docs/directory-and-recovery.md).
