# Configuration reference

Use `envarpay init` to generate a small, editable setup. No wallet, agent process
or payment is created by initialization. `--json` provides the same summary for scripts.

## Choose a role

| Role | `--pay-to` means | Files |
|---|---|---|
| `buyer` | The other seller's full receiving address | `buyer.toml`, `wallet-command.json`, optional native `host-config.json`, `SETUP.md` |
| `seller` | Your own receiving address | `seller.toml`, `SETUP.md` |
| `both` | Your own receiving address | Both configs and wallet connection files; separate state paths |

With `both`, use `--peer-pay-to` for the other seller. A non-default `--peer-url`
requires that address explicitly. The default both-role example points its buyer
at its own local seller; use different peers for an actual agent-to-agent setup.

## Initialization options

```sh
envarpay init --help
```

| Option | Default | Meaning |
|---|---|---|
| `--agent` | `mcp` | `openclaw`, `hermes`, `opencode`, `goose`, `langgraph`, `pydantic-ai`, or generic `mcp` |
| `--role` | `both` | Generate only the payment files you need |
| `--mode` | `seller` | Existing paid-setup mode, or `private` for an authenticated service without a payment wallet |
| `--directory` | `./agent-pay` | Empty output directory; existing files are never overwritten |
| `--pay-to` | Required | Full EVM receiving address, according to the role table |
| `--peer-url` | `http://127.0.0.1:4020/mcp` | Buyer's allowed paid MCP endpoint |
| `--peer-pay-to` | Local seller in the both-role example | Other seller's address; only for `both` |
| `--upstream` | `http://127.0.0.1:8000/mcp` | Private MCP capability behind the seller gate |
| `--tool` | `ask_agent` | One priced/allowed tool; add other tools later in TOML |
| `--price` | `0.01` | Seller price in USDC |
| `--max-per-call` | `0.01` | Buyer per-call limit in USDC |
| `--budget` | `0.01` | Buyer cumulative limit in USDC; does not reset daily |
| `--allow-http` | Off | Allow remote plain HTTP for explicit private-container networking |
| `--backend` | `mcp` | Advanced seller adapter: `mcp`, experimental `openclaw` or `hermes-http` |
| `--json` | Off | Machine-readable initialization summary |

`--agent` selects a guide and buyer connection format. It does not download an
agent, expose a conversation, select an LLM or choose a different seller backend.
Existing HTTP runtimes require an explicit `--backend` choice. A custom tool name
and `--upstream` apply to the MCP backend.

Amounts must be positive decimal strings with at most six decimal places.
`0.000001` becomes exactly 1 atomic unit; `0.01` becomes 10000. Scientific notation,
negative numbers and fractions smaller than one atomic unit are rejected, never rounded.
The per-call limit must not exceed the cumulative budget. TOML retains atomic integers.

## Buyer configuration

The generated file is equivalent to:

```toml
schema_version = 1
network = "eip155:84532"
rpc_url = "https://sepolia.base.org"
state_dir = "./buyer-state"

[wallet]
key_file = "./buyer.key"
payments_enabled = false
max_per_call_atomic = 10000
max_total_atomic = 50000

[wallet.peers.seller]
transport = "streamable-http"
url = "https://seller.example/mcp"
pay_to = "REPLACE_WITH_SELLER_FULL_ADDRESS"
tools = ["ask_agent"]
```

Replace the address before loading this explanatory example. `init` writes the
validated address you provided. All relative key/state paths resolve relative
to the config file, not the working directory. Keep existing paths when upgrading.

Peer names such as `seller` are operator-owned aliases. The model cannot introduce
an arbitrary endpoint or recipient. Configure another `[wallet.peers.NAME]` table
for another counterparty; retain its exact tools and receiving address.

Review the configuration, fund the dedicated **testnet** wallet, and only then
set `payments_enabled = true`. Never paste a private key into TOML, prompts, a
host-config snippet or a public issue. `envarpay keygen` writes an owner-only file
and refuses to overwrite an existing key.

## Seller configuration

```toml
schema_version = 1
network = "eip155:84532"
rpc_url = "https://sepolia.base.org"
state_dir = "./seller-state"

[seller]
pay_to = "REPLACE_WITH_YOUR_FULL_ADDRESS"
host = "127.0.0.1"
port = 4020

[seller.tools.ask_agent]
amount_atomic = 10000

[seller.backend]
kind = "mcp"

[seller.backend.upstream]
transport = "streamable-http"
url = "http://127.0.0.1:8000/mcp"
```

Use your real address when running `init`. Each priced tool must exist on the
upstream. The gate preserves its input schema and result. Seller keys are not
needed; the facilitator settles the buyer's signed USDC authorization.

For container networking, set `seller.host = "0.0.0.0"`, configure
`seller.allowed_hosts` for the intended gate hostname, and explicitly allow HTTP
for private peers. Public traffic needs HTTPS. Never publish the unpaid upstream.
See the [native seller recipe](selling.md#native-cli-seller-in-docker).

For stdio upstreams set `transport = "stdio"`, `command` and `args`, omitting `url`.
For SSE use `transport = "sse"` with its `/sse` URL. An optional
`bearer_token_env` names a server-owned HTTP credential; URLs cannot contain credentials.

## Generated wallet connection

`wallet-command.json` contains the absolute interpreter path and arguments for
launching the wallet. Any native MCP client can use these as stdio launch parameters.
Four native hosts additionally receive `host-config.json`:

| Host | Merge key | Typical config location |
|---|---|---|
| OpenClaw | `mcp.servers.envarpay` | `~/.openclaw/openclaw.json`, or the selected profile/config path |
| Hermes | `mcp_servers.envarpay` | `$HERMES_HOME/config.yaml`, normally `~/.hermes/config.yaml` |
| OpenCode | `mcp.envarpay` | Project `opencode.json`, or the host's selected config |
| Goose | `extensions.envarpay` | `~/.config/goose/config.yaml` (honor your XDG override) |

JSON is also valid YAML. Merge the generated subtree; **do not replace the whole
host file**, including its model, tools or existing extensions. The generated
interpreter path belongs to EnvarPay's environment, not the host's Python.

If the host needs proxy/credential environment variables, configure them explicitly
in its MCP child-process environment. The wallet key remains in its referenced
private file. For local/container endpoints, put their names in `NO_PROXY`.

## Inspect before running

```sh
envarpay doctor --config ./my-wallet/buyer.toml
envarpay doctor --config ./my-service/seller.toml --online
```

Doctor shows chain ID, official USDC contract, recipients, tool prices, buyer
limits, payment enablement and whether a key file exists. `valid` means the
configuration parsed; key presence is not key validity or proof of wallet control.
`--online` additionally checks the RPC chain for payment configs and lists the connected runtime tools for service/seller configs. It never pays, runs a task or
certifies end-to-end readiness. Neither mode creates a payment ledger.

## Defaults and state

Initialization always uses Base Sepolia, official USDC
`0x036CbD53842c5426634e7929541eC2318f3dCF7e`, two confirmations and payments off.
Advanced network/timeouts remain explicit TOML settings; no mainnet switch is hidden
in an agent preset. The current alpha's mainnet profile is not live-payment validated.

Do not re-run `init`, move to a fresh state directory or raise a budget to clear an
uncertain attempt. Preserve the original request ID, payload and nonce and follow
[the failure semantics](getting-started.md#payment-and-failure-semantics).

## Private authenticated entry

`--mode private` preserves the existing service-connection workflow. Omit `--role`
and wallet addresses: this mode writes `agent.toml`, an owner-only `service.token`,
and `SETUP.md`. It creates an access credential, never an EVM key. The token is
excluded by the generated `.gitignore` and never printed in the summary. See
[private service setup](getting-started.md#connect-a-private-existing-service).

## Optional recovery and Envar connection

The default wallet exposes four core tools, including `recover_payment`. Set
`wallet.peers.NAME.recovery = true` only for an approved EnvarPay service that
implements the authenticated recovery endpoint. Recovery can resume an already-paid
request whose execution never started; it is more than a read-only status check.
It never creates a replacement signature or calls settle again.

`[connection]` enables optional directory/reporting features, and `[wallet_server]`
can expose the wallet through an authenticated private MCP endpoint in a separate
container. Receiving updates from Envar are separately opt-in and never change the
buyer's budget or key. See the complete [directory/recovery reference](directory-and-recovery.md).
