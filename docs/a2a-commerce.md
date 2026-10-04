# A2A commerce implementation

EnvarPay is adding an independent TypeScript A2A service commerce runtime. It can
operate without an Envar account: sellers define services and receiving profiles;
buyers retain their own authorization policy and budget.

The runtime now exposes authenticated A2A service entries with SQLite order and
Task storage, a persistent dispatch queue and an official A2A upstream client.
Free services execute directly. The seller can now collect exact x402 USDC before
dispatching a paid task, with independent receipt verification. The buyer signer,
MPP adapter and platform integration are later milestones. Automated fixtures
use simulated settlement and do not prove a real transfer.

## Build and validate

```sh
cd packages/typescript
npm ci --ignore-scripts
npm run build
node dist/commerce/cli.js validate --config examples/seller.json
node dist/commerce/cli.js card --config examples/seller.json \
  --service research --offer usdc-once --origin https://seller.example
```

The example addresses and hosts are placeholders; validation does not contact them.
`validate` and `card` never create keys, change a wallet policy, call a model or pay.

## Run a free A2A service

`validate` and `card` remain read-only. `serve` starts the actual configured Agent
executor, so configure a bounded service and the model credentials in that runtime.

```sh
node dist/commerce/cli.js serve --config seller.json \
  --state ./private/commerce.sqlite3 --credentials ./private/runtime-auth.json \
  --origin https://YOUR_PUBLIC_ORIGIN --host 127.0.0.1 --port 4020
```

The owner-only credentials file has `callers` (strong bearer token to buyer ID)
and `upstreams` (service ID to private runtime bearer token) maps. Never publish
this file. The public reverse proxy must preserve the configured Host and use
HTTPS. Card and JSON-RPC routes follow `/services/SERVICE/vREV/offers/OFFER/`.

The service accepts one structured JSON data part matching its input schema.
Send `A2A-Version: 1.0`, `Authorization: Bearer ...`, and standard `SendMessage`.
Set `configuration.returnImmediately=true` for asynchronous work and query the
returned Task ID with `GetTask`. Replaying the same caller/message/offer/input
returns the original Task. Changed input or offer conflicts. Read access is scoped
to the authenticated buyer and service revision.

This milestone supports initial tasks only. Runtime cancellation, nonterminal
continuation and explicit remote reconciliation are subsequent work; unsupported
operations are refused. A lost upstream outcome becomes durable `unknown` with
`recoveryRequired` metadata, never a second automatic execution.

SQLite uses an OS-released exclusive ownership transaction in a companion database;
only one runtime instance may own a ledger. Restart preserves results and moves
interrupted dispatches to unknown. This is single-instance storage, not a shared
multi-replica database. The Node runtime entry is `@envarai/envarpay/commerce/server`;
the configuration entry does not import `node:sqlite`.

## Services and prices

`research` is a repeatable service, not an Agent or one execution. Each service has
an immutable revision, bounded JSON input contract, deliverables and one or more
offers. Each offer gets a deterministic A2A URL. Alternative USDC and USD offers
are separate choices; they are not two charges for the same purchase.

- `free` + `none`: validated free task input, no payment profile.
- `fixed` + `upfront`: known total in smallest currency units.
- `quantity` + `upfront`: integer unit price multiplied by a validated input array.

All other modes are rejected. The current initial-task contract requires zero
included revisions; a future revision entitlement must not make arbitrary Tasks
free. Input schemas cannot resolve remote references. Maximum quantities must
refer to declared, bounded arrays. Card purchases require at least USD 0.50 and
a resolved merchant profile before quoting.

The schema files in `packages/typescript/schemas/` are the configuration authority.
Envar's service editor must consume the published schema rather than maintain a
different copy of its rules.

## TypeScript API

```ts
import {
  loadCommerceConfig, buildQuote, assertQuoteRequest, createOfferCard,
} from '@envarai/envarpay/commerce';

const config = loadCommerceConfig(sellerJson);
const input = { topic: 'Agent directory', competitors: ['A', 'B'] };
const quote = buildQuote(config, {
  serviceId: 'research', offerId: 'usdc-once',
  caller: authenticatedCaller, messageId: stableMessageId,
  input,
});
assertQuoteRequest(quote, authenticatedCaller, stableMessageId, input);
const card = createOfferCard(config, 'research', 'usdc-once', publicOrigin);
```

`quote.paymentProfile` is a copied/frozen settlement snapshot, not a live reference
to editable seller settings. Runtime code must persist that quote before payment,
then validate the official x402/MPP challenge and credential against it. PriceQuote
is an internal object, not a new public payment protocol.

## Dependencies and verification

The pinned official `@a2a-js/sdk 1.2.1` exports the A2A 1.0 model and codecs;
its version number is not the protocol version. This milestone checks actual
serialization rather than relying on repository-main documentation. x402 core/EVM
and the payment-identifier extension are pinned to 2.24.0. Seller tests exercise
the unmodified official x402 client, concurrency, replay, lost responses, frozen
challenges, encrypted credential restart/tamper checks and simulated RPC receipts.
Real testnet delivery remains a separate release acceptance requirement.

`npm test` discovers all Node test files. Existing MCP client checks remain while
implementation work proceeds; they are not evidence for the new A2A payment path.
The final release will replace the old public entry with the complete A2A SDK;
there is no requirement to preserve the previous product API.

## x402 seller configuration and recovery

An x402 profile requires these additional **private** credential-file fields:

```json
{
  "payers": {"authenticated-buyer-id": "0xBUYER_ADDRESS"},
  "vaultKeyFile": "/private/vault.key",
  "rpcUrls": {"eip155:84532": "https://YOUR_BASE_SEPOLIA_RPC"}
}
```

Merge with `callers` and `upstreams`; placeholders are not usable values. The vault
key is 32 random bytes in an owner-only file. Keep the ledger, companion ownership
database, encrypted `authorizations/` and vault key together in a consistent private
backup. Never mount them into the Agent's unrestricted execution environment.

The public request is still standard A2A `SendMessage`. The unpaid response has
HTTP 402 + `PAYMENT-REQUIRED`; retry the same request with the official x402
`PAYMENT-SIGNATURE`. The frozen resource URL includes a quote identifier, copied
by the official client. No private Envar payment payload is required. Optional
standard `payment-identifier` values are deduplicated per caller; an economic nonce
cannot buy two orders even when a client omits the extension.

Before settle, the runtime persists the original signature encrypted and records
its chain checkpoint. It confirms payment only after matching the official token,
exact Transfer, AuthorizationUsed nonce, canonical block and confirmation depth.
A lost or unverified result stays `unknown`: execution is blocked and the signature
must not be replaced. `X402Gate.recover(orderId, caller)` reads the original receipt,
or searches AuthorizationUsed logs from the saved checkpoint without settling
again. More than 100,000 blocks requires an operator/archive lookup; absence of
logs never becomes proof of non-payment. Public management recovery is added with
the buyer-management milestone.

Upfront payment does not promise escrow, automatic refunds or acceptance-based
release. Payment success and task execution success are stored separately.
