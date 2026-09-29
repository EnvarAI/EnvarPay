# envar-pay

An installable Python package and CLI for **MCP + x402 v2** agent payments.
It can put an upfront USDC payment gate in front of an existing MCP service or an
official Hermes runtime, and expose a bounded buyer wallet as an MCP server.

Version `0.1.0a1` is an alpha. This package is an Envar adapter using official SDKs;
it is not an official Hermes/x402 distribution or a new payment protocol.
The package has not been published to PyPI.

## Install

Python 3.11 or newer:

```sh
python -m pip install .
envar-pay --help
```

For a Hermes seller, install into **the Python environment used by your existing
official Hermes**. Hermes itself is not bundled or installed by this package.
If Hermes uses uv, `uv pip install --python /path/to/hermes/.venv/bin/python .`
installs the adapter without changing Hermes source. A buyer wallet or MCP proxy
can run in its own environment and does not require Hermes.

The tested Hermes 0.20.0 project has a 14-day uv release-age setting. If installing
from that project before x402 2.24.0 ages past it, the example Dockerfile makes a
package-specific exception: `--exclude-newer-package x402=2026-09-29T23:59:59Z`.
It keeps the exact x402 pin and does not disable the age setting for other packages.

## Enable receiving payments

```sh
envar-pay init --directory ./agent-pay --pay-to YOUR_WALLET_ADDRESS --backend hermes
```

Edit `agent-pay/seller.toml`: set your model endpoint/model, price and system prompt.
Provide the model credential through the configured environment variable or a
0600 `api_key_file`. Then start:

```sh
envar-pay doctor --config ./agent-pay/seller.toml --online
envar-pay serve --config ./agent-pay/seller.toml
```

The `ask_agent` MCP tool accepts `{ "question": "..." }`. It returns x402
PaymentRequired until payment settles and the exact USDC Transfer plus original
authorization nonce are independently verified. Only then does Hermes run.
The seller needs a **receiving address, not its private key**.

Both transports are available: Streamable HTTP at `/mcp`, SSE at `/sse`.
Default bind is `127.0.0.1:4020`. Public hosting requires your own HTTPS reverse
proxy, explicitly configured `host`/`allowed_hosts`, and protection of the unpaid
backend so it cannot bypass this gate. Do not expose the wallet's stdio interface.

For an existing MCP service use `--backend mcp`, configure
`seller.backend.upstream` (HTTP, SSE or stdio), and list only the tools to sell:

```toml
[seller.tools.summarize]
amount_atomic = 10000 # 0.01 USDC, not 10000 USDC

[seller.backend]
kind = "mcp"

[seller.backend.upstream]
transport = "streamable-http"
url = "http://127.0.0.1:8000/mcp"
```

The gateway preserves tool schemas, content, structured results and metadata.
The scope is MCP tools/call, not transparent forwarding of resources, prompts,
sampling, elicitation, long-running tasks or bidirectional server requests.

## Enable paying for other agents

`init` also writes `buyer.toml` with **payments disabled**. Generate a separate key:

```sh
envar-pay keygen --output ./agent-pay/buyer.key
```

Only the public address is displayed. The command refuses to overwrite a key.
Fund the address on the selected network. Review the buyer config:

- Allowed peer endpoints, tool names and full recipient addresses.
- Network, official USDC contract selected by the package, per-call atomic amount.
- **Cumulative** budget for this state directory (not a daily reset).
- Set `payments_enabled = true` only after reviewing those values.

Generated examples use **Base Sepolia** and a 10000-atomic per-call/total cap.
Base mainnet is also represented in configuration, but this alpha has not been
validated with a new mainnet payment. Its facilitator must support that network;
the sample public facilitator is for the tested Sepolia flow. Use separate state
and keys for separate networks; never fund demonstration wallets with mainnet money.

Wire the wallet into official Hermes through its normal `mcp_servers` config:

```sh
envar-pay hermes-config --config ./agent-pay/buyer.toml
```

This prints a JSON object (also valid YAML). Merge its `mcp_servers.payments` entry
into your Hermes config; the command does not overwrite personal configuration.
It uses an absolute Python interpreter and config path. When your proxy or peer
credentials live in environment variables, explicitly pass those variables using
Hermes's MCP `env` mapping. No key value belongs in the model's context.

Hermes sees `list_paid_tools`, `call_paid_tool`, and `payment_status`. The wallet
has its own allowlist; arbitrary URLs from the model are not accepted. A generic
MCP client still needs this x402-capable component to pay.

Equivalent direct CLI calls:

```sh
envar-pay tools --config ./agent-pay/buyer.toml --peer seller
envar-pay probe --config ./agent-pay/buyer.toml --peer seller \
  --tool ask_agent --arguments '{"question":"What is your price?"}'
envar-pay call --config ./agent-pay/buyer.toml --peer seller \
  --tool ask_agent --arguments '{"question":"Summarize these notes..."}' \
  --request-id weekly-review-001
envar-pay status --config ./agent-pay/buyer.toml --operation-id buy:weekly-review-001
```

`probe` makes an unpaid tool call and never signs. A truly free upstream tool may
execute that unpaid call, so use it only against a known paid capability.
Use the **same request ID** for the same logical call. A completed retry returns
the stored result; an unresolved retry refuses another signature. A new ID is a
new purchase, subject to the remaining total budget.

## Payment and failure semantics

The package supports official USDC EIP-3009 `exact`, x402 v2, `paymentFlow=upfront`
on Base Sepolia (`eip155:84532`) and the configured Base mainnet profile (`eip155:8453`).
It validates the recipient, amount, token/domain, network, resource and timeout
before reserving budget and signing. Gas is paid by the facilitator, according to
that facilitator's policy. No proprietary intent or settlement API is added.

SQLite transactions serialize budget reservations across local processes.
The original signed authorization is stored before submission. The seller binds
an authorization nonce to one tool/arguments and will not settle or execute an
unresolved attempt again. Successful results are cached for identical replays.
This is conservative duplicate prevention, **not an automatic crash-recovery or
exactly-once execution guarantee**. If a process dies after charging, keep the
state and investigate; do not delete it or create a new request ID to retry blindly.

```sh
envar-pay reconcile --config ./agent-pay/buyer.toml --operation-id buy:weekly-review-001
```

`reconcile` only checks an already recorded transaction on chain. It never signs,
resubmits, releases reserved budget, reruns a task or promises a refund. If the
transaction hash was lost before it was recorded, manual nonce/chain investigation
is still needed. The state database contains signed authorizations and task data;
keep the directory 0700 and files 0600. Do not share it or commit it.

Two block confirmations are the default receipt threshold, not L1 finality.
Execution can still fail after payment. Refunds, disputes, multi-host locking,
external signing providers and marketplace discovery are outside this release.
The included signer is a local dedicated key; operating it in the same account as
an agent with shell access does not isolate that key. Run it under a separate OS
identity/container with narrowly scoped funding when isolation is needed.
Publishing a seller in a marketplace also needs separate wallet-control proof;
accepting an address in this CLI does not certify its ownership.

## SDK compatibility and validation

- Pins official `x402==2.24.0` and `mcp==1.26.0` because their MCP major versions
  are not interchangeable.
- Uses the upstream async payment wrapper that actually settles upfront. It
  adapts low-level MCP results directly, avoiding the broken FastMCP helper in
  this pinned x402 release.
- The prior [two-Hermes POC](proof-of-concept.md) contains
  real Sepolia payment evidence. Package unit/transport tests use simulated
  facilitator responses and are **not additional real payments**.

```sh
python -m pip install -e ".[test]"
pytest
ruff check src tests
python -m build
```

The wheel/sdist can be distributed without a custom runtime image. Examples under
`examples/` validate installation in the official Hermes image and native MCP
registration without signing or changing your personal Hermes configuration.
