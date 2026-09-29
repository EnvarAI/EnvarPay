# Cross-framework Docker acceptance (in progress)

These recipes are experimental test infrastructure. They are not a declaration
that all frameworks work. See [the validation ledger](../../docs/integrations/validation.md).
The required matrix is six runtimes × five different counterparties: **30 directed
purchases**. Each runtime must act as both buyer and seller. LangGraph with the
LangChain MCP adapter counts as one runtime; Pydantic AI is another.

## Source and environment boundaries

`sources.json` records the official repository, default branch and resolved SHA.
Use those exact commits throughout one run. Resolve fresh official commits when
starting a new run, then record the resulting image IDs and installed dependencies.
Do not replace the native host with a generic MCP client and call that host tested.

Place each checkout at `<context>/<name>/source`, its source record at
`<context>/<name>/source.json`, and the corresponding Dockerfile in `<context>`.
The Python recipe expects both `langgraph` and `langchain` checkouts.

First build the current EnvarPay wheel and SDK image from the repository root:

```sh
python -m build --wheel
docker build -f examples/Dockerfile.sdk -t envarpay:matrix-sdk .
```

The pinned official Hermes image is only a reusable Python/Node toolchain base.
The latest Hermes source is separately installed into `/opt/hermes-latest` on
Python 3.14. It does not run the base image's old Hermes code as acceptance.
Other native runtimes have their own dependency environments. In particular,
EnvarPay uses MCP 1.26 while current Hermes/FastMCP use MCP 2.

Build a native image from the prepared context, for example:

```sh
docker build -f Dockerfile.python -t envarpay:matrix-python .
docker build -f Dockerfile.hermes -t envarpay:matrix-hermes .
docker build -f Dockerfile.opencode -t envarpay:matrix-opencode .
docker build -f Dockerfile.goose -t envarpay:matrix-goose .
```

`PYPI_INDEX` and `NPM_REGISTRY` build arguments can select a reachable package
index. Do not change dependency pins just to make a download succeed. The Goose
recipe builds the native CLI from source with hosted-model and external-MCP
support; local inference, desktop and voice features are not part of this test.
OpenClaw's current source recipe and native test harness remain pending.

## Python framework harness

`native_python.py` uses the native LangChain agent loop or Pydantic AI agent loop.
Seller mode exposes a bounded `ask_agent` MCP tool; place the EnvarPay payment
gate in front of it. Buyer mode connects the independent wallet MCP through the
framework's own MCP adapter. Probe mode discovers tools and calls payment_status
without needing a model key or making a payment.

Mount only the test run's config/state and its dedicated credentials:

- `/run/secrets/llm_api_key`: model credential, read-only; never bake into an image.
- `/run/secrets/buyer.key`: the individual buyer's dedicated test key, read-only.
- `/state`: that wallet's existing private ledger, preserved between runs.
- `/evidence`: private native runtime events; review/redact before publishing.
- `/config/buyer.toml`: reviewed peers, exact recipients and persistent budget.

The raw seller runtime must be private to the Docker network. Do not publish it
as a second unpaid entry point. Do not mount the Docker socket or personal agent
home directory. A runtime with shell access and the same UID as the wallet is
not a custody isolation boundary; use only bounded dedicated test wallets here.

Example read-only probe inside the Python image:

```sh
/opt/langgraph/bin/python /harness/native_python.py langgraph probe --config /config/buyer.toml
/opt/pydantic-ai/bin/python /harness/native_python.py pydantic-ai probe --config /config/buyer.toml
```

These are runnable candidates awaiting successful native image builds. Do not
report them as tested solely because Python syntax checks or SDK tests pass.

## Evidence required for every directed purchase

1. A real model calls the wallet through the named framework's native tool loop.
2. An unpaid request produces PaymentRequired and does not start seller work.
3. Save the original authorization before submission; bind it to the purchase.
4. Read the real Base Sepolia receipt independently: official USDC address,
   exact payer/payee/amount, original AuthorizationUsed nonce and confirmations.
5. The seller's native runtime starts after receipt verification and returns the
   task's expected result. The buyer receives that result.
6. Repeating the completed request returns saved delivery without a new payment
   or execution. Preserve ambiguous attempts and never re-sign them automatically.

No private key, original signed payload or full private ledger belongs in public
evidence. Each directed case needs its own transaction; the earlier two-Hermes
POC does not count toward this new 30-case matrix. Funding transfers are separate
from paid agent deliveries. Mainnet and package publication are outside this run.
