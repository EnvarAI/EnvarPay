# A2A commerce runtime

EnvarPay 0.2 is an independent TypeScript/Node service commerce runtime. Sellers
publish services and prices; buyers retain signing keys, explicit recipient
allowlists and cumulative budgets. The public task wire is official A2A 1.0,
with native x402 v2 or MPP payment credentials. Envar is optional.

Once this source version is published, install the alpha from npm with
`npm install @envarai/envarpay@0.2.0-alpha.7`. Node22.14+ is required; Node24 is
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

For new **skill-named services**, `configVersion: 2` makes the service ID and
display name exactly the installed skill name. The seller runtime pins the
skill's content digest and must provide an enforcing skill adapter. A generic
A2A endpoint or a matching Card label is insufficient. EnvarPay grants the
purchased skill for this Task, allows declared free skills, and refuses another
paid skill without a separate purchase. Buyer-facing A2A does not change.
The [skill-gate design](../plans/skill-named-services.md) documents adapter and
publication requirements. Legacy version 1 orders keep their original terms.

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
npx --package @envarai/envarpay@0.2.0-alpha.7 envarpay init --directory ./private
npx --package @envarai/envarpay@0.2.0-alpha.7 envarpay validate --config ./private/seller.json
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

## Native installed skills (configVersion 2)

A service's `id` and `name` must both equal its installed `SKILL.md` name. Use
`execution: {type: "skill", cardUrl: "https://your-agent/.well-known/agent-card.json", skillDigest: "<package SHA256>"}`.
The runtime derives the digest from all package files. The public Agent Card advertises
multiple installed skills; the Envar service editor selects them without a mapping table.
Ordinary A2A offer paths, authenticated callers, x402/MPP and result Tasks remain unchanged.

The built-in native adapter supports **instruction-only text tasks** for Hermes/OpenClaw.
Review the skill, pin its source and license, and add `envar-runtime: instruction-only` to
its frontmatter. Its directory and frontmatter `name` must match. Skills requiring scripts,
web browsing, external APIs or file access need a separately reviewed execution adapter.

In the private seller credentials file add:

```json
{
  "skills": {
    "framework": "hermes",
    "skillsDirectory": "/absolute/installed-skills",
    "freeSkills": ["plain-language"],
    "stateDirectory": "/absolute/private/skill-tasks",
    "python": "/absolute/hermes/bin/python",
    "model": "your-configured-model",
    "baseUrl": "https://your-model-provider/v1",
    "apiKeyFile": "/absolute/private/model.key"
  }
}
```

For OpenClaw, set `framework: "openclaw"`, use a Python 3 interpreter, and add
`command: ["/absolute/node", "/absolute/openclaw/openclaw.mjs"]`. The installed framework
must support the adapter's native configuration. Unsupported versions fail without fallback.
Keep credentials/state owner-only. Run the usual `envarpay serve` command; no user mapping is
required. Register its `/.well-known/agent-card.json`, then select each installed skill in Envar.

Each order creates a fresh native home and workspace, loads only the purchased skill and
explicit free helpers, and exposes no model tools. Hermes uses `enabled_toolsets=[]`;
OpenClaw uses an isolated config with `tools.deny=["*"]`. Both verify the resolved tool list.
No other paid skill files, personal memory, peer credentials or wallet keys are supplied to the
model. The selected package digest is checked before quote/payment and execution. Installed
skill calls are the authorization boundary; a model's general knowledge is not partitionable
by topic, and directory metadata is not a capability/quality attestation for arbitrary sellers.

Task state is durable before native dispatch. A crash does not silently run it twice; original
orders remain recoverable. Payment success and execution success remain separate facts.
A free offer authorizes its selected skill for that task, even if that skill also has a paid
offer. Only entries in `freeSkills` are available as helpers to other tasks.

If the facilitator loses its broadcast result and no transaction is found, seller
recovery may reject the original authorization only after the same independent
finalized-block proof used by the buyer establishes that it expired unused. This
closes the seller's unknown state without execution or another settlement.
