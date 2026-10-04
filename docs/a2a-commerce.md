# A2A commerce runtime

EnvarPay 0.2 is an independent TypeScript/Node service commerce runtime. Sellers
publish services and prices; buyers retain signing keys, explicit recipient
allowlists and cumulative budgets. The public task wire is official A2A 1.0,
with native x402 v2 or MPP payment credentials. Envar is optional.

Once this source version is published, install the alpha from npm with
`npm install @envarai/envarpay@0.2.0-alpha.4`. Node22.14+ is required; Node24 is
recommended. Review configuration before enabling payments. The `next` dist-tag
tracks this new runtime; the older `latest` tag still identifies the previous
wallet-client package. Verify the exact archive in the [release channels](packages.md).

The [official A2A TCK subset](a2a-conformance.md) records the selected protocol
checks and their limits. Invalid versions and request media types return the
official JSON-RPC error before quotation, payment or execution.

## Services, offers and tasks

A service is a repeatable bounded capability; `research` is an example ID, not an
Agent instance or a single purchase. Its immutable revision fixes the execution
entry, input JSON Schema, deliverables, target duration and offers. One offer has
one deterministic Card and A2A endpoint. USDC and card offers are alternatives,
not two payments for one task.

- `free` with `collection.kind: none`: validates input and executes without payment.
- `fixed` with `upfront`: exact configured total in smallest currency units.
- `quantity` with `upfront`: integer unit price times the count of a schema-bounded
  input array. The buyer cannot supply a different price or count.

MVP permits zero included revisions. A waiting nonterminal Task can accept
clarification that preserves existing input and only adds declared optional
fields, within ten rounds. Terminal Tasks cannot be appended. Arbitrary new work
requires a new reviewed purchase. Input validation cannot turn an unrestricted
upstream assistant into an isolated research capability; configure and describe
the execution boundary honestly.

## Seller setup

```sh
npx --package @envarai/envarpay@0.2.0-alpha.4 envarpay init --directory ./private
npx --package @envarai/envarpay@0.2.0-alpha.4 envarpay validate --config ./private/seller.json
```

Replace placeholder upstreams, addresses and prices. Private credential files must
be owner-only. Seller credentials contain `callers` (bearer token to buyer identity)
and `upstreams` (service ID or service:revision to native bearer token). Explicit
`upstreamInputEncoding` entries may select `json-text` for native runtimes that
accept text, with `data` as default. There is no automatic fallback or second task.

For x402, also configure `payers` (caller to EVM address), `vaultKeyFile` (32 random
bytes) and `rpcUrls` keyed by CAIP-2 network. Sellers collect by address and do not
need the receiving wallet's private key. MPP needs an eligible Stripe account,
explicit test/live mode, private credentials and challenge key; see the buyer and
provider guides before enabling it.

```sh
envarpay serve --config seller.json --credentials private/seller-auth.json \
  --state private/seller.sqlite3 --origin https://seller.example --port 4020
```

Keep the raw Agent private. The HTTPS reverse proxy must preserve the configured
Host. A2A endpoints are `/services/SERVICE/vREV/offers/OFFER/a2a` and Cards end with
`/agent-card.json`. The SDK exports seller APIs at `@envarai/envarpay/server`.

## Native payment and Task wire

Use `Authorization: Bearer ...` and `A2A-Version: 1.0` for A2A. `SendMessage`
contains one user data part matching the service input schema, with a stable
messageId. `configuration.returnImmediately: true` returns a Task shell. Reuse
that Task ID with `GetTask`; reads never charge.

x402 uses HTTP402 + `PAYMENT-REQUIRED`, followed by the same A2A request and
`PAYMENT-SIGNATURE`. The server persists the native challenge and quote, checks
identity/amount/recipient, stores the original authorization encrypted and then
settles. Work begins only after independent canonical receipt, exact official
USDC Transfer, authorization nonce and confirmation-depth checks.

MPP uses the official SDK's `WWW-Authenticate: Payment` challenge. With application
authentication present, its standard `header` field selects `Payment-Authorization`,
leaving Bearer identity untouched. The SDK creates native Stripe PaymentIntents
using the original SPT and idempotency identity. PaymentIntent retrieval verifies
amount, merchant binding, mode and original quote metadata before dispatch.

Stripe readiness reads the authenticated account and its documented
`/v2/network/business_profiles/me` under one pinned preview version. Both profile
identity and `livemode` must match. Sandbox `profile_test_...` identities are
accepted; live card activation is checked only for live operation. The
[built-in SPT issuer](stripe-issuer.md) uses the public token API and a separate
seller-scoped credential for independent PaymentIntent reads. Current supported
country/account access and buyer funding remain prerequisites for real charges.

Cards optionally describe the application's service contract via
`urn:envarpay:commerce:1`; x402 challenges include optional quote display metadata
at `urn:envarpay:quote:1.info`. These are application descriptors, not a new A2A or
payment standard. The settlement adapter removes its local display metadata from
facilitator requests. Standard A2A clients can invoke offers and native x402
clients can pay without Envar platform IDs. The default reviewed buyer path
uses seller service metadata. An explicit [standard-only peer policy](a2a-standard-peers.md)
supports independent A2A/x402 sellers without these descriptors; its terms are locally
reviewed, and ambiguous paid requests are never reposted.

## Buyer, recovery and Envar

The `/client` entry offers the persistent buyer and private management API.
[Buyer guide](a2a-buyer.md) covers exact peer policy, preview/confirm, BigInt budgets,
free offers and original-operation recovery. [Native Agent guide](a2a-agents.md)
connects Hermes/OpenClaw through a private fixed-peer A2A proxy when their native
clients cannot insert a payment transport.

Payment confirmed, Task completed and accepted delivery are separate states.
Timeout is not a decline. Unknown payments retain their original authorization
and reserved budget. Recovery uses the original nonce/transaction/SPT/Task; an
expired EIP-3009 reservation releases only after a canonical finalized block
proves it expired and unused. Upfront payment does not provide escrow or automatic
refunds. [Runtime recovery](a2a-runtime-recovery.md).

Envar opt-in config sync applies only locally authorized service, upstream,
recipient and protocol changes, records actual application, then acknowledges its
digest. The platform verifies the public Card and unpaid challenge before
publication. [Configuration integration](a2a-envar.md). No platform signer is added.

SQLite supports one process per ledger. Preserve databases, vault, keys and
immutable revisions together. Do not mount wallet state into an Agent's arbitrary
shell. `/healthz` describes process liveness; `/readyz` also reads the ledger and rejects a
fatal worker failure. These checks do not guarantee third-party provider availability.
Use the local owner-only [inspection and recovery guide](commerce-operations.md)
to find unknown operations and preserve a consistent offline backup.

## Release evidence

The official SDK versions are pinned in the lockfile. Local/CI tests use explicit
simulators where documented. Separate acceptance records demonstrate native
model execution and USDC transfer; they do not prove every provider, every
framework version or live card eligibility. MPP live collection remains disabled
until the operator has an eligible merchant, supported SPT issuance/recovery and
independent merchant identity proof. Configuration or mock success cannot supply
those external capabilities.
