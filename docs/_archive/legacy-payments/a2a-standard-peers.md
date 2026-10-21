# Buy from a standard A2A/x402 seller

An explicit `standard-a2a` peer can call an independent A2A 1.0 JSON-RPC seller
using native x402 v2 exact USDC, without EnvarPay, an Envar account, or the EnvarPay
commerce/quote extensions. Its native payment resource can be the ordinary
endpoint URL without a `quote` query parameter.

The owner must review the service and approve a known paid-only endpoint. Local
input and price rules authorize spending; they are not seller-supplied delivery,
refund or acceptance promises. A Card alone does not prove paid-only behavior.
Existing peers retain the strict EnvarPay contract mode when `mode` is omitted.
There is no automatic fallback from a failed strict offer check.

## Policy example

Replace the placeholder hosts and payee with independently reviewed values.
`100` is 100 atomic token units, or 0.0001 USDC.

```json
{
  "policyVersion": 1,
  "paymentsEnabled": true,
  "approval": "per_purchase",
  "peers": [{
    "id": "independent-research",
    "mode": "standard-a2a",
    "cardUrl": "https://seller.example/.well-known/agent-card.json",
    "endpoint": "https://seller.example/a2a",
    "authentication": "none",
    "protocol": "x402",
    "currency": "eip155:84532/erc20:0x036cbd53842c5426634e7929541ec2318f3dcf7e",
    "recipient": "0x2222222222222222222222222222222222222222",
    "maxPerPurchase": "100",
    "localContract": {
      "revision": 1,
      "offerId": "research",
      "inputSchema": {
        "type": "object",
        "properties": {"request": {"type": "string", "minLength": 1, "maxLength": 1000}},
        "required": ["request"],
        "additionalProperties": false
      },
      "amount": "100",
      "paidOnly": true
    }
  }],
  "budgets": [{
    "currency": "eip155:84532/erc20:0x036cbd53842c5426634e7929541ec2318f3dcf7e",
    "maxTotal": "200",
    "period": "cumulative"
  }]
}
```

The endpoint must be exact HTTPS, share the Card's origin, and contain no query,
fragment or URL credentials. The Card must advertise that exact A2A 1.0 JSON-RPC
interface; other interfaces are ignored. `peerEndpoints` cannot redirect it.

`authentication: "none"` sends no Bearer header and does not need a peer token.
For `"bearer"`, supply the usual private `peerTokens[id]`. Credentials are never
discovered from a Card. The local offer ID, revision and quote service identifier
are review references, not invented seller skill identifiers. Requests carry one
standard data Part containing the validated input; put seller-required routing
fields in that input schema.

## Preview and approval

Use the existing `CommerceBuyer.preview()`/`confirm()` or private management API:

```ts
const preview = await buyer.preview('owner', {
  cardUrl: 'https://seller.example/.well-known/agent-card.json',
  offerId: 'research', messageId: 'one-intended-job',
  input: {request: 'The reviewed bounded work'}
});
// Review local policy terms and native payment conditions before authorizing.
if (preview.quote.termsSource !== 'local-policy') throw new Error('Unexpected profile');
const purchase = await buyer.confirm('owner', {
  previewId: preview.id, quoteToken: preview.quoteToken, messageId: preview.messageId
});
```

Preview validates input before one unpaid `SendMessage`. That known paid-only
endpoint must return HTTP 402; a free/success response is rejected before signing.
The native challenge must contain exactly one permitted match for amount, official
supported USDC, network and payee, and its resource must equal the approved URL.
Only EIP-3009 exact transfer is accepted. The pinned SDK requires the correct
EIP-712 asset name/version; optional transfer-method/payment-flow values cannot
request a conflicting mechanism. Timeout must be an integer from 1 to 300 seconds.

`expiresAt` is the local review deadline derived from that timeout, not an asserted
seller-supplied absolute expiry. Confirmation uses the official SDK to sign with
the frozen native timeout. Independent receipt verification and cumulative budget
reservation remain mandatory.

The ledger freezes original request bytes, native challenge, selected requirements
and local-policy digest. A mode, endpoint, authentication or local-contract change
invalidates the prior preview. Quotes explicitly carry `termsSource: "local-policy"`;
no seller deliverable or acceptance terms are fabricated.

## Recovery and result limits

A2A message IDs do not promise idempotent execution by an unrelated seller.
Initial confirmation sends the frozen paid request once; repeated confirmation
only reads that purchase. Recovery verifies the original receipt/nonce and, when a
Task ID is known, sends only standard `GetTask` without a payment header.

An ambiguous paid POST without a Task ID returns `standard_task_recovery_required`.
It is never automatically reposted, signed again, or assigned a guessed Task ID.
The owner must obtain the original result through the seller's supported recovery
process. Existing finalized-chain proof can release a demonstrably expired unused
authorization; uncertain proof retains its reservation. These rules survive restart.

A received Task keeps its actual ID. An immediate A2A Message is stored as a
Message, without inventing a remote Task. Included clarification is not assumed:
`continue()` rejects this mode while the original Task remains readable. Do not
change peer mode or erase the ledger to force a retry.

## Test boundary

`test/commerce-standard-peer.test.mjs` uses official A2A and x402 server handlers
with an independent executor, without EnvarPay seller classes or Envar metadata.
The signer, facilitator and receipt verifier are simulated. This proves protocol
interoperability and recovery policy; it does not claim real USDC transfer or model
inference. Live payment acceptance is a separate bounded operation.
