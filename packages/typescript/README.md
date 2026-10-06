# EnvarPay TypeScript

Independent service commerce for user-operated Agents. Public communication uses
A2A 1.0; payments use native x402 v2 exact USDC or MPP Stripe charge. Prices and
scope are versioned configuration, enforced before dispatch, not instructions in
a prompt. Envar is an optional directory and management UI.

The 0.2 source line replaces the previous npm wallet-only MCP client. Build from
this checkout while the release is undergoing acceptance; a source version is
not evidence that its npm/OCI artifact is published.

## Runtime and entry points

For Hermes onboarding, see [guided Skill setup](../../docs/hermes-skill-setup.md). The `setup --file ...` command reads the owner's local model configuration and creates a private seller with an empty catalog, ready for the first service to be configured in Envar.

Node.js 22.14+ (Node 24 recommended). SQLite is single-instance. Contracts can be
read without loading the seller or buyer runtime; Bun validation covers the
contracts entry, not the SQLite server.

| Entry | Purpose |
|---|---|
| `@envarai/envarpay` | Config types/validation, integer pricing, quotes and A2A Cards |
| `/server` | Durable seller A2A handler, exact x402 gate and native upstream executor |
| `/client` | Buyer policy, atomic budgets, original-operation recovery and private management |
| `/mpp` | Opt-in native MPP seller and read-only Stripe reconciliation |
| `/envar` | Optional bounded config pull/ack and durable observation reports |

```sh
npm ci --ignore-scripts
npm run build
node dist/commerce/cli.js init --directory ./private
node dist/commerce/cli.js validate --config ./private/seller.json
```

Initialization writes examples and a vault key; it never creates a purchase or
funds a wallet. Replace example addresses/hosts and review service limits before
starting. Keep Agent model credentials in the Agent, and signer keys in a separate
private wallet boundary.

```sh
node dist/commerce/cli.js serve --config seller.json \
  --credentials private/seller-auth.json --state private/seller.sqlite3 \
  --origin https://seller.example --port 4020
node dist/commerce/cli.js buyer-serve --config buyer-policy.json \
  --credentials private/buyer-auth.json --state private/buyer.sqlite3 \
  --origin https://buyer-management.example --port 4021
```

The management service is private and owner-authenticated. A website may request a
quote and confirm an already-reviewed purchase; it cannot change peers, recipient
allowlists, budgets or signing keys. Unknown outcomes retain the original request,
signature/SPT and reserved budget. Never create a replacement purchase after a
timeout.

[Seller and wire behavior](../../docs/a2a-commerce.md) ·
[Buyer management](../../docs/a2a-buyer.md) ·
[Continuation and recovery](../../docs/a2a-runtime-recovery.md) ·
[Envar configuration integration](../../docs/a2a-envar.md)

## Payment guarantees

Payment confirmation, task completion and acceptance are separate facts. The MVP
charges upfront for a new task; reads and permitted clarification use that same
purchase. It does not provide escrow, automatic refunds, subscriptions or billing
for arbitrary internal tools. A2A compatibility alone does not give an Agent a
wallet or authorize payment.

MPP requires an eligible Stripe merchant, a permitted buyer token-creation flow,
explicit test/live mode and any required customer authentication. Simulator tests
are not card charges. Provider and chain acceptance must be recorded separately
from SDK tests and build results.
