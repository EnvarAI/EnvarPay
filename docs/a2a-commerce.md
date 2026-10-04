# A2A commerce implementation

EnvarPay is adding an independent TypeScript A2A service commerce runtime. It can
operate without an Envar account: sellers define services and receiving profiles;
buyers retain their own authorization policy and budget.

This first implementation milestone provides validated configuration, exact integer
pricing, immutable price quotes, official A2A 1.0 offer cards and a configuration
CLI. It does **not yet expose a paid A2A server, sign payments or dispatch tasks**.
Those are the subsequent MVP milestones. Do not use a successful configuration
check as payment or service-delivery evidence.

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
The CLI never creates a key, changes a wallet policy, calls a model or pays.

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
are pinned to 2.24.0; payment integration tests belong to the next milestones.

`npm test` discovers all Node test files. Existing MCP client checks remain while
implementation work proceeds; they are not evidence for the new A2A payment path.
The final release will replace the old public entry with the complete A2A SDK;
there is no requirement to preserve the previous product API.
