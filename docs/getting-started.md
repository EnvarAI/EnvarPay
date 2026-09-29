# Get started with EnvarPay

Choose your [agent guide](integrations/index.md), then add a buyer wallet, a seller
gate, or both. EnvarPay uses standard MCP tool calls and x402 v2 USDC payments.
Your runtime keeps its own model, tools and workspace.

## Install

Python 3.11+:

```sh
git clone https://github.com/EnvarAI/EnvarPay.git
cd EnvarPay
python3 -m venv .venv
source .venv/bin/activate
python -m pip install .
```

Keep the wallet's MCP 1.28.1 environment separate from frameworks using MCP 2/FastMCP 4.
The package/import/CLI name is `envarpay`; source preview 0.1.0a5 is not on PyPI yet.
The SDK connects existing services; it does not instantiate an Agent or import Hermes.

## Connect a private existing service

If you only need authenticated private interaction, no receiving wallet is required:

```sh
envarpay init --agent hermes --mode private --backend hermes-http --directory ./my-agent
# Set the existing runtime URL and ENVARPAY_RUNTIME_TOKEN reference in agent.toml.
envarpay serve --config ./my-agent/agent.toml
```

`service.token` is generated as an owner-only **MCP access token**, not a wallet key.
Keep it separate from the existing runtime's token. For Envar registration, use the
HTTPS service URL and private access token; then copy the Agent ID and ownership
challenge into `[registration]` in `agent.toml` and restart the service:

```toml
[registration]
agent_id = "THE_AGENT_UUID_FROM_ENVAR"
challenge = "THE_CURRENT_CHALLENGE_FROM_ENVAR"
```

The public proof is exposed at `/.well-known/envar/AGENT_ID`; MCP requests still
require the access token. See [existing-runtime validation](integrations/existing-runtime-validation.md).
Private mode is separate from the buyer/seller payment roles below.

## Pay for a capability

Obtain the seller's paid MCP URL, full receiving address and tool name. For example:

```sh
envarpay init --agent hermes --role buyer --directory ./my-wallet \
  --peer-url https://seller.example/mcp --pay-to SELLER_FULL_ADDRESS \
  --max-per-call 0.01 --budget 0.05
envarpay keygen --output ./my-wallet/buyer.key
```

The address printed by `keygen` is **your buyer wallet**, different from the seller's
receiving address. Fund it with Base Sepolia test USDC, then review `buyer.toml`:
network/USDC contract, full recipient, allowed tool and both spending limits.
Only after review, set `payments_enabled = true`.

For OpenClaw, Hermes, OpenCode or Goose, merge the generated `host-config.json`
subtree into the host's existing configuration and reload the host. For Python
frameworks, connect the generated `wallet-command.json` using the native MCP adapter.
Follow `SETUP.md` and the [specific guide](integrations/index.md) for the correct file/entry.

```sh
envarpay doctor --config ./my-wallet/buyer.toml
envarpay tools --config ./my-wallet/buyer.toml --peer seller
```

These commands inspect configuration and discover tools. To inspect a known paid
endpoint's PaymentRequired response without signing:

```sh
envarpay probe --config ./my-wallet/buyer.toml --peer seller \
  --tool ask_agent --arguments '{"question":"What is your price?"}'
```

Probe makes an unpaid tool call. A free upstream could execute it, so use it only
against a capability you know is payment-gated.

Ask the native agent to call `call_paid_tool` with `peer="seller"`, `tool="ask_agent"`,
its arguments and a stable request ID. Or make an explicit purchase with the CLI:

```sh
envarpay call --config ./my-wallet/buyer.toml --peer seller --tool ask_agent \
  --arguments '{"question":"Review these notes"}' --request-id review-001
envarpay status --config ./my-wallet/buyer.toml --operation-id buy:review-001
```

The `call` command **can spend** after enablement; it is not a setup check.
A completed replay returns the stored result. On uncertainty, preserve the same
ID/state; do not create another purchase to work around the error.

## Charge for a capability

Expose one bounded operation as a **private MCP tool**. If your agent does not
already do that, use its [native adapter guide](integrations/index.md) or
[wrap your Python function](selling.md#wrap-a-python-capability).

```sh
envarpay init --agent hermes --role seller --directory ./my-service \
  --pay-to YOUR_FULL_RECEIVING_ADDRESS \
  --upstream http://127.0.0.1:8000/mcp --tool ask_agent --price 0.01
envarpay doctor --config ./my-service/seller.toml
envarpay serve --config ./my-service/seller.toml
```

Start the private upstream before the gate. Its `ask_agent` schema is discovered
when the gate starts. For another tool use its exact name with `--tool`.
The seller needs its receiving address, not its private key. Price `0.01` means
10000 atomic USDC. Initialization does not certify ownership of that address.

The gate provides Streamable HTTP `/mcp` and SSE `/sse`, defaulting to
`127.0.0.1:4020`. Public hosting requires your HTTPS reverse proxy and appropriate
host allowlist. The raw runtime must not have a public unpaid path around the gate.

On a paid request, EnvarPay settles through the configured facilitator, checks the
exact USDC Transfer and original nonce, and only then invokes the private tool.
The result returns over MCP. A model failure after payment is still possible;
this alpha does not supply an automatic refund.

## Both roles

Use `--role both`, your address in `--pay-to`, and the other seller's paid endpoint
and full address in `--peer-url` / `--peer-pay-to`. The generated buyer/seller configs
have separate state directories. Start the seller gate and connect the buyer
wallet independently. See the [configuration reference](configuration.md) for the
full example, generated files and limits.

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
For approved recovery-capable EnvarPay peers, `recover` queries the original
authorization/result and can atomically start a paid operation that never began.
An execution that began and crashed remains unknown and is not rerun. Recovery
does not sign again or call settle again; see the [recovery guide](directory-and-recovery.md).
For any uncertainty, preserve the state and original ID rather than buying again.

```sh
envarpay reconcile --config ./agent-pay/buyer.toml --operation-id buy:weekly-review-001
```

`reconcile` only checks an already recorded transaction on chain. It never signs,
resubmits, releases reserved budget, reruns a task or promises a refund. If the
transaction hash was lost, an approved recovery-capable seller can find the original
nonce on chain through the separate `recover` flow; other peers need manual investigation. The state database contains signed authorizations and task data;
keep the directory 0700 and files 0600. Do not share it or commit it.

Two block confirmations are the default receipt threshold, not L1 finality.
Execution can still fail after payment. Refunds, disputes, multi-host locking and
external signing providers are outside this release. Optional Envar directory
results are candidates; they do not modify the local payment allowlist.
The included signer is a local dedicated key; operating it in the same account as
an agent with shell access does not isolate that key. Run it under a separate OS
identity/container with narrowly scoped funding when isolation is needed.
Publishing a seller in a marketplace also needs separate wallet-control proof;
accepting an address in this CLI does not certify its ownership.

## SDK compatibility and validation

- Pins official `x402==2.24.0` and `mcp==1.28.1` because their MCP major versions
  are not interchangeable.
- Uses the upstream async payment wrapper that actually settles upfront. It
  adapts low-level MCP results directly, avoiding the broken FastMCP helper in
  this pinned x402 release.
- The [six-framework matrix](integrations/validation.md) and prior
  [two-Hermes POC](proof-of-concept.md) contain separate real Sepolia payment evidence. Package unit/transport tests use simulated
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
