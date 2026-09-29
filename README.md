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

**EnvarPay** is an open-source Python SDK and CLI that connects agents to
**MCP + x402 v2** payments. Put a USDC payment gate in front of an existing MCP
tool or Hermes agent, and give buyers a wallet tool with an explicit spending budget.

### Two sides. One package.

| | Command | What it does |
|---|---|---|
| **Get paid** | `envar-pay serve` | Quote a price, confirm payment, then execute your agent's capability. |
| **Pay others** | `envar-pay wallet` | Give an MCP-capable agent a payment tool constrained by your allowlist and budget. |

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

- **Keep your agent.** Works with existing MCP tools and an installed official Hermes runtime.
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
envar-pay --help
```

This alpha is not on PyPI yet. You can also install the wheel from
[GitHub Releases](https://github.com/EnvarAI/EnvarPay/releases).
For a Hermes seller, install into Hermes's Python environment; see the
[Hermes setup notes](docs/getting-started.md#install).

### Start receiving payments

```bash
envar-pay init --directory ./agent-pay --pay-to YOUR_WALLET_ADDRESS --backend hermes
# Configure your model and capability in agent-pay/seller.toml.
envar-pay serve --config ./agent-pay/seller.toml
```

Your paid `ask_agent` tool is available at `http://127.0.0.1:4020/mcp` (or `/sse`).
The seller needs its receiving address, not its private key.
Already run an MCP service? Choose `--backend mcp` and configure which tools to sell.

### Give an agent a payment wallet

```bash
envar-pay keygen --output ./agent-pay/buyer.key
# Fund the dedicated test wallet; review the recipient and budget in buyer.toml.
# Payments default to OFF. Enable them only after reviewing the configuration.
envar-pay hermes-config --config ./agent-pay/buyer.toml
```

Merge the generated `mcp_servers.payments` entry into Hermes's MCP configuration.
Other MCP clients can launch the same `envar-pay wallet --config ...` process.
The agent gets `list_paid_tools`, `call_paid_tool` and `payment_status`.

For a direct call:

```bash
envar-pay call --config ./agent-pay/buyer.toml --peer seller --tool ask_agent \
  --arguments '{"question":"Help our team plan a weekly knowledge review"}' \
  --request-id weekly-review-001
```

For an embedded integration:

```python
from pathlib import Path
from envar_pay import WalletService, load_config

wallet = WalletService(load_config(Path("agent-pay/buyer.toml")))
result = await wallet.call(
    "seller", "ask_agent", {"question": "Review these notes"}, "review-001"
)
```

### What has been proven?

A prior two-container Hermes POC paid **0.01 test USDC on Base Sepolia**, then
delivered a real model-generated answer. Buyer balance: 20 → 19.99. Seller: 0 → 0.01.

**[View the on-chain transaction](https://sepolia.basescan.org/tx/0xade8b0b108ae664162e2c01530ed03a01ac4f25a52e0036140f28bcccd7ea213)** · [Evidence and its limits](docs/proof-of-concept.md)

The extracted package has been tested with an official Hermes 0.20.0 image,
clean wheel installation, real model connectivity and local MCP transport tests.
Those tests are not additional blockchain payments. The package rechecked the
existing POC receipt; a new package-version live payment is still pending.

### Current scope

`0.1.0a1` is an **alpha**, not a production financial system. Defaults use Base
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
