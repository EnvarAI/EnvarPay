# Native cross-framework Docker acceptance

The 2026-09-29 run attempted **30 directed purchases**: each of six runtimes buys
from the other five. **28 paid deliveries passed; two settlements failed.**
See the [transaction matrix](../../docs/integrations/validation.md) and its JSON
receipts, actual results, source commits and image IDs. No host-installed agent
counts toward this test. CI only built public runtime files; the payment tests
ran on the operator's local Docker engine.

## Build from official development branches

[sources.json](sources.json) records official repositories, branches and full
commits resolved at the start of the run. Keep those commits fixed for a complete
matrix. Resolve fresh commits before a new run, then record its new image IDs.
OpenCode's default development branch is `dev`; LangChain's is `master`; the others
use `main`. A version label alone does not establish the source commit.

Build the EnvarPay wheel and toolchain base:

```sh
python -m build --wheel
docker build -f examples/Dockerfile.sdk -t envarpay:matrix-sdk .
```

That recipe installs dependencies. The recorded live run reused a previously
verified dependency layer with the new wheel; **its SDK image was not a clean
installation**. The base image supplies tools only: its old Hermes is not the
Hermes runtime tested here. Current Hermes lives under `/opt/hermes-latest`.

The online `Dockerfile.*` recipes and [build_artifacts.py](build_artifacts.py)
build from the pinned source. The latter can run on ARM Linux or through the
repository's runtime-build workflow. The [offline recipes](offline/) are the
recipes actually used to import downloaded public ARM Linux bundles locally:

| Image suffix | Recipe | Build-context contents |
|---|---|---|
| `openclaw` | `offline/Dockerfile.openclaw` | `openclaw/openclaw-runtime.tar.gz`, `sources.json` |
| `hermes` | `offline/Dockerfile.hermes` | `hermes-main/`: Python archive, source archive, `hermes/` wheelhouse, `sources.json` |
| `opencode` | `offline/Dockerfile.opencode` | `opencode/opencode` binary and `sources.json` |
| `goose` | `offline/Dockerfile.goose` | `goose/goose` binary and `sources.json` |
| `python` | `offline/Dockerfile.python` | `python-main/`: `langgraph/`, `pydantic-ai/` wheelhouses, `sources.json` |
| `pydantic` | `offline/Dockerfile.pydantic` | `python/`: `pydantic-ai/` wheelhouse, `sources.json` |

`sources.json` in each row goes inside the named bundle directory. Match its
relevant framework SHA to the run catalog before building. OpenClaw bundles use
tar so `.pnpm` links and executable permissions survive transport. Record a
SHA256 for each downloaded bundle and verify it before extraction. Artifacts
can expire on GitHub; the pinned build scripts are the rebuild path.

## Configure a dedicated runtime

Copy the appropriate [buyer or seller profile](profiles/) into a **new dedicated**
runtime home, preserving its relative file layout. These examples contain model
configuration but no credentials. Review the endpoint/model for your provider.
Do not overwrite personal profiles or mount personal workspaces.

EnvarPay wallet and payment gate run in their own environment. Current LangChain
and Pydantic AI use FastMCP 4/MCP 2; their buyer client uses the official
`Client(..., mode="legacy")` against the MCP 1.26 wallet. Dependencies stay separate.

The scripts below must run **inside the corresponding Docker image**:

| Framework | Native harness command prefix |
|---|---|
| OpenClaw | `/opt/envarpay/.venv/bin/python /harness/native_cli.py ROLE --framework openclaw` |
| Hermes | `/opt/envarpay/.venv/bin/python /harness/native_cli.py ROLE --framework hermes` |
| OpenCode | `/opt/envarpay/.venv/bin/python /harness/native_cli.py ROLE --framework opencode` |
| Goose | `/opt/envarpay/.venv/bin/python /harness/native_cli.py ROLE --framework goose` |
| LangGraph/LangChain | `/opt/langgraph/bin/python /harness/native_python.py langgraph ROLE` |
| Pydantic AI | `/opt/pydantic-ai/bin/python /harness/native_python.py pydantic-ai ROLE` |

Replace `ROLE` with `seller`, `buyer`, or `smoke`. Buyer/smoke also require
`--prompt-file /prompt.txt`; Python buyers also require `--config /config/buyer.toml`.
Python `probe --config /config/buyer.toml` lists/calls the status tool without a
model payment. CLI/native dispatch is implemented in [native_cli.py](native_cli.py);
framework agent loops are in [native_python.py](native_python.py).

Mount only the dedicated run's files:

| Container path | Purpose |
|---|---|
| `/harness/native_cli.py` or `/harness/native_python.py` | Corresponding checked-out script, read-only |
| `/run/secrets/llm_api_key` | Model credential, read-only |
| `/run/secrets/buyer.key` | Dedicated test-wallet key, buyer only, read-only |
| `/config/buyer.toml` | Reviewed wallet config, read-only |
| `/state/buyer` | Existing private wallet ledger, retained between runs |
| `/runtime-home` | Dedicated native profile **and** persistent workspace |
| `/evidence` | Private event directory; redact before publication |
| `/prompt.txt` | Buyer task, read-only |

Use `--init` for CLI containers. Set `ENVARPAY_AGENT_ROLE=buyer` or `seller` for
OpenClaw. Set `OPENCODE_CONFIG=/runtime-home/opencode.json` for OpenCode. Python
frameworks read `MODEL_BASE_URL`; Goose reads `OPENAI_BASE_URL`. The native harness
loads the model key from the mounted file into `ENVARPAY_MODEL_API_KEY`; Goose's
provider also needs `OPENAI_API_KEY`. It does not print the credential.

Latest OpenClaw uses `agents.entries` and `memory.search`. Its workspace is
`/runtime-home/workspace`, retained with the profile. Never delete its workspace
protection flags or wallet ledger to recover from a failed run.

## Separate the payment gate from the private seller

1. Create one private Docker network for each raw seller and one buyer-facing
   network. Connect the payment-gate container to both; connect the raw runtime
   only to its own network. Do not publish the runtime's host port.
2. Start `ROLE=seller`. It exposes the bounded `ask_agent` tool at port 8000 `/mcp`.
3. Initialize `seller.toml` using `envarpay init --backend mcp`, set the upstream
   to `http://runtime-NAME:8000/mcp`, set the receiving address and price, and set
   allowed hosts for the gate. Run `envarpay serve --config /config/seller.toml`
   in the SDK image, with the seller's separate persistent `/state/seller` mount.
4. Configure each buyer's peer to the payment gate, never the raw runtime. Set
   exact recipients, allowed tools and budget. Payments remain disabled until
   the operator reviews and explicitly enables that dedicated test configuration.
5. Ask the native buyer to call `call_paid_tool` once with a fixed request ID.
   Do not solve the seller task in the controller, change IDs after uncertainty,
   or allow an agent to create a second purchase on error.

A `docker network --internal` network has no model-provider egress. The live run
used private user-defined networks without host ports so native sellers could
reach their configured model provider. No Docker socket was mounted. If a proxy
is necessary, configure it explicitly and put localhost, all `pay-*` and relevant
`runtime-*` names in `NO_PROXY`. Container localhost is not the host proxy address.

These test containers run native tools under the same identity as the wallet;
this is **not** a custody isolation boundary. Use only bounded dedicated test keys.
The wrappers execute one task; they are not a production session broker.

## Audit without another payment

The recorded run used Base Sepolia official USDC, 100 atomic per purchase,
500 atomic per buyer in total, two confirmations and a fixed task marker per pair.
Every successful purchase must have native tool dispatch, chain receipt, exact
Transfer and AuthorizationUsed nonce, seller start after proof, delivered output,
and completed-ID replay with no new transaction or seller execution.

```sh
python examples/cross-framework/audit_run.py \
  --private-state /path/to/private-run \
  --run-dir /path/to/run-artifacts \
  --output /path/to/public-audit.json
```

The auditor reads the existing matrix ledgers, private native events and per-case
replay proofs. It uses raw RPC independently of EnvarPay's receipt validator,
checks wallet balances, and exports only selected public fields. It never signs,
settles, releases a budget or reruns an agent. Its request naming/100-atomic
expectations are specific to this recorded matrix, not a generic merchant API.

Both failed settlements retain original IDs, signed payloads and budget reservations.
No automatic recovery of lost transaction hashes or ambiguous execution is claimed.
Mainnet and package publication are outside this run.
