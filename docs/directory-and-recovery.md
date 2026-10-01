# Directory, purchase recovery and reporting

The wallet has four core MCP tools: `list_paid_tools`, `call_paid_tool`,
`payment_status` and `recover_payment`. An optional Envar connection adds
`discover_agents` and `get_agent`. Directory results are candidates only: the
model cannot modify the wallet's peers, recipients, tools, network or budgets.
The operator must add a peer to the local allowlist before it can receive payment.

```toml
[connection]
platform_url = "https://envar.ai"
agent_id = "YOUR_REGISTERED_AGENT_UUID"
token_file = "./envar.token"

[wallet.peers.researcher]
url = "https://YOUR_APPROVED_PEER/mcp"
pay_to = "YOUR_APPROVED_FULL_ADDRESS"
tools = ["ask_agent"]
agent_id = "THE_REGISTERED_PEER_UUID"
endpoint_id = "THE_REGISTERED_ENDPOINT_UUID"
recovery = true
```

`agent_id` and `endpoint_id` enable platform observation. They do not grant
payment authority. Enable `recovery` only for a verified EnvarPay service that
exposes `envarpay_payment_status`; arbitrary MCP services may lack durable recovery.

## Recover the original operation

The wallet persists request content, endpoint policy, a private recovery token,
budget reservation and the original signed authorization before submitting it.
An unresolved operation continues to reserve its budget. Neither a restart nor a
new request ID silently buys that same unresolved work again.

```sh
envarpay status --config buyer.toml --operation-id buy:task-001
envarpay recover --config buyer.toml --request-id task-001
```

Recovery queries the original service and authorization. It never signs a new
payment or calls settle again. The seller can independently find the original
AuthorizationUsed event and verify its exact canonical USDC receipt. Once payment
is confirmed, a request that never started can atomically claim execution. An
execution that started and then crashed remains unknown; it is not run again.
A completed result is saved before its response leaves the seller.

The private recovery token is required for replay and result queries. The seller
stores its hash. A public chain transaction, nonce or authorization signature is
not a credential to read task results. Standard clients without this additional
credential can receive their first response but cannot use this recovery facility.

Payment and execution state are separate. A confirmed payment with a failed or
unknown execution is not a refund. Inspection and original-result recovery remain
available when new purchases are disabled.

## Keep signing authority outside the Agent

For an Agent with shell access, put the wallet in a separate container/process
permission boundary. Mount the signing key, policy and state only into the wallet;
never give the Agent the wallet's filesystem, Docker socket or signing key.

```toml
[wallet_server]
host = "0.0.0.0"
port = 4021
allowed_hosts = ["wallet:4021"]
bearer_token_file = "./wallet-service.token"
```

Run `envarpay wallet-serve --config buyer.toml` on a private network and configure
the Agent's native MCP client with that URL and strong bearer credential. Expose
only the selected private Agent entry or public paid seller through a tunnel.
Never publish wallet controls in the public directory or expose them anonymously.
For Envar website purchases, use a dedicated, strong-bearer HTTPS entry reachable
by Envar; this deliberately grants the platform access within the local wallet
allowlist and budget. Revoke it locally and in Envar when no longer needed.
Direct agent-only wallets can remain on a private network. `wallet` remains available for trusted stdio
hosts; sharing an OS user with unrestricted shell access is not key isolation.

## Optional platform observations

With `[connection]`, the buyer reserves an externally executed Invocation and
attaches its ID as namespaced MCP metadata alongside standard x402 metadata.
The platform is an observer; signing and settlement remain user-side.

Events persist with stable UUIDs in the existing local Store and are acknowledged
individually. `envarpay sync --config buyer.toml --watch` (and the seller equivalent)
retries reports without buying or executing anything. A platform outage leaves
reports pending. It does not replace the operation ID or create a second payment.

The receiving platform must implement the bound-Agent `/invocations/{id}/reports`
contract. A failed report stays pending, including when that dependent platform
version is not deployed yet. Buyer and seller claims are separate from independent
chain verification; no SDK report alone means the platform verified payment.

Tests cover real local TCP authentication, lost responses, exact result replay,
interrupted and concurrent execution, unchanged authorizations/budget and reporter
outages. Test facilitator/chain responses are simulated. Final two-account native
Hermes paid delivery is tracked by the dependent platform acceptance.

## Apply receiving settings from Envar

A dedicated seller can opt in to receiving the UI's wallet address and fixed tool
prices by setting `connection.accept_receiving_updates = true`. `serve` polls the
bound Agent's receiving configuration, validates the shared `Receiving` schema,
persists it atomically, and swaps the service used by new calls. Calls already in
flight retain their original configuration. An acknowledgement failure is retried
without restarting a purchase. The config directory must be writable; mount the
directory rather than a single config file when using Docker.

Only the seller's receiving address and prices can be applied. Buyer wallets and
runtime settings are never accepted in that response. A network change requires
selecting the same network locally first. Turning the opt-in off in the local
file immediately prevents further changes. The platform separately checks live
PaymentRequired responses; an application acknowledgement alone is not proof of
correct pricing or an actual payment.
