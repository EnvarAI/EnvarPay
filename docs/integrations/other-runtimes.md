# Connect another agent or language

Use the protocol your existing agent actually supports. Its implementation language
does not have to match a separately operated payment service.

| Existing entry | Buyer/payment route | Seller/receiving route |
|---|---|---|
| Native MCP tools | Load generated wallet-command.json (stdio) or connect the authenticated wallet HTTP endpoint | Put the Python payment gate in front of a private MCP capability |
| Python application | Embed WalletService, or use the host's MCP adapter | Embed PaidServer, or expose one private MCP function behind the gate |
| JS/TS or Bun application | Import @envarai/envarpay and connect to the wallet service | Keep your existing Node MCP server and put the separate Python gate in front |
| Rust/Go/another host language | Use your official MCP client with the wallet's command/args or URL/token | Expose a private MCP tool or thin callable adapter |
| Callable HTTP agent | Connect a reviewed private HTTP adapter | Use the documented fixed-target HTTP connector where compatible; check its acceptance scope |
| Native CLI agent | Connect wallet MCP tools through the CLI's supported host config | Use a bounded CLI-to-MCP wrapper with a dedicated profile |
| UI-only agent with no callable entry | Needs a separate supported integration | Cannot be made a paid API merely by installing a package |

Start a generic wallet setup with `envarpay init --agent mcp --role buyer` and your
approved receiving address/peer options from [the quickstart](../getting-started.md).
Use the emitted `wallet-command.json`; do not guess a Python path or overwrite an
existing host config. Official SDKs implement the MCP transport.

For a seller, [selling.md](../selling.md) includes an existing MCP endpoint, a Python
function wrapper and native CLI recipes. The payment gate only runs the private
capability after the exact receipt check. Publishing the raw capability creates a
path around that gate, so keep it private.

If installing Python on the agent host is unsuitable, run EnvarPay under another
process/user, on a separate machine, or build the repository's standalone Dockerfile.
The agent connects to that service over MCP. Public agent/seller entries need HTTPS;
the wallet remains private. No published container image or native plugin is implied.

[OpenClaw](openclaw.md), [Hermes](hermes.md), [OpenCode](opencode.md), [Goose](goose.md),
[LangGraph/LangChain](langgraph.md) and [Pydantic AI](pydantic-ai.md) have concrete guides
and a [testnet validation matrix](validation.md). Those results cover the listed
versions/paths; validate the actual entry, policy, payment and delivery for a new adapter.

[Envar features](../envar.md) · [npm client](../../packages/typescript/README.md) ·
[Python API](../python-sdk.md) · [separate task mode](../tasks/README.md)
