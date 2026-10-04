# Independent A2A purchase wallet

The TypeScript commerce buyer runs in the wallet owner's environment. It uses the
pinned official A2A and x402 SDKs, needs no Envar account or platform domain, and
keeps signing keys out of the management API. This implementation supports exact
USDC upfront purchases on configured Base networks, native MPP Stripe purchases
through an explicit provider boundary, and free offers. It does not provide escrow,
refunds or automatic purchase replacement.

## Construct the wallet

The integration points are `BuyerStore`, `CommerceBuyer`, `BuyerManagement` and
`listenBuyerManagement`. Package exports and CLI wiring are maintained alongside
these modules; use the export present in the exact installed package version.

```ts
const store = new BuyerStore('/private/wallet/buyer.sqlite3');
const vault = new CredentialVault('/private/wallet/authorizations', encryptionKey);
const buyer = new CommerceBuyer({
  policy: loadBuyerPolicy(policyJson),
  store,
  vault,
  signer: dedicatedViemAccount,
  peerTokens: { seller: sellerBearerToken },
  verifyReceipt: evmReceiptVerifier(rpcUrls, 2),
  ...evmSettlementRecovery(rpcUrls),
});
const management = new BuyerManagement({
  buyer,
  origin: 'http://127.0.0.1:4021',
  authenticate: bearerAuthenticator({ [managementToken]: 'local-owner' }),
});
const listener = listenBuyerManagement(management);
```

Use a separate operating-system identity for the wallet. A process that can read
the wallet's files or alter its policy can authorize its money. Keep the 32-byte
vault encryption key, signer key, SQLite ledger and authorization directory
private and back them up consistently. The SQLite ownership lock admits one
process and is released by the operating system after a crash. Multiple replicas
must not share this single-instance ledger.

Policy defaults and explicit limits come from `buyer-policy.schema.json`.
`paymentsEnabled: false` allows quote inspection but blocks signing. Every
confirmation supplies the exact preview token and message ID, including for
`within_preapproved_limits`; a host that uses that mode must choose to confirm
inside its existing local authorization. Seller metadata never expands policy.
Limits use currency-specific integer strings in smallest units and are cumulative.

## Preview and approve

1. `POST /management/v1/purchases/preview` with `{cardUrl, messageId, input, offerId}`.
2. Review the returned quote's amount, currency, recipient, payer, terms digest,
   input digest and expiry.
3. `POST /management/v1/purchases/confirm` with `{previewId, quoteToken, messageId}`.
4. Read `GET /management/v1/purchases/{id}`. This reads persisted state only.
5. If Stripe requires customer authentication, use the owner-only
   [MPP authentication flow](#mpp-customer-authentication) below.
6. If required, `POST /management/v1/purchases/{id}/recover` with `{}`. It reads the
   original Task or recovers the original payment operation; it never creates a
   replacement authorization.

All routes require Bearer authentication. Each credential maps to a stable local
caller identity, and callers cannot inspect or confirm one another's purchases.
Message IDs cannot be reused by another caller sharing the wallet: the remote
seller credential can represent one common buyer identity.

The allowed Card URL must match exactly. By default only its sibling `/a2a`
endpoint is reachable. A nonstandard Card path requires an explicitly configured
`peerEndpoints[peerId]` on the same HTTPS origin. The Card cannot change that
endpoint, redirect a credential, or authorize another payment recipient. Requests
and responses are bounded. The management listener defaults to loopback; remote
access requires an explicit HTTPS origin behind a controlled TLS proxy, exact Host
validation and strong independent management credentials. It does not enable CORS.

The default seller-advertised preview uses the optional
`urn:envarpay:commerce:1` Card metadata and `urn:envarpay:quote:1.info` challenge metadata.
These describe the selected business offer; A2A and x402 remain standard transports.
To buy from an independent standard-only A2A/x402 seller, explicitly configure
[standard-a2a local policy](a2a-standard-peers.md). Its reviewed terms are local policy,
not a claim that the seller published EnvarPay metadata. Default peers do not
automatically downgrade into that mode. Paid-peer free-offer preview is
rejected because sending a free request could execute work immediately. Dedicated
free peers instead preview the Card locally without sending a Message. A seller
that falsely advertises a paid offer could still execute its own service; the buyer
will not sign if it receives no matching 402.

## Payment and recovery facts

A confirmation atomically reserves `reserved + spent + proposed <= maxTotal`
before signing. A checkpoint failure or quote expiry that is proven to occur before
the signer is invoked rejects that local attempt and releases its reservation. Once
the signer is invoked, errors remain unknown and reserved. The exact original authorization is encrypted and durably stored
before sending it. Once an authorization might exist, an unknown outcome keeps
its reservation. The process does not assume that a timeout or an expired quote
means no money moved. If a crash interrupts signing before the original credential
is saved, the purchase requires operator reconciliation; a second signature is
never created automatically.

The original HTTP body and payment credential are reused byte-for-byte on replay.
A Task handle is subsequently read with standard `GetTask`, without another payment
credential. The receipt becomes `confirmed` and budget becomes `spent` only after
independent canonical-chain verification of the exact token transfer and original
EIP-3009 authorization nonce. A server's success response alone is insufficient.
Task results and payment verification are separate: work can be complete while
payment verification remains unknown, and payment can succeed while execution fails.

Management snapshots may include the original transaction receipt and authorization
nonce for independent observation. They never expose the signature, private key,
vault path, management token, seller token or Stripe authentication action.
No component creates an automatic replacement purchase or an automatic refund.

Tests in `commerce-buyer.test.mjs` use simulated facilitation, signing and chain
verification. They prove budget/ownership/recovery behavior, not a real on-chain
purchase. Release acceptance requires a separately authorized real wallet, receiver,
budget, provider execution and canonical receipt readback.

## Progress and clarification

Call `buyer.start()` to observe known working Tasks every two seconds using only
`GetTask`. After restart the persisted Task IDs are resumed. Stop observation and
await `buyer.stop()` before closing its store. The observer does not replay payment
credentials, sign, settle or release budgets. Unknown payment verification still
requires explicit recovery. Terminal and waiting Tasks stop automatic polling.

`POST /management/v1/purchases/{id}/continue` accepts `{messageId, input}` for the
original owner's confirmed, waiting Task. `input` is the full cumulative service
input and must satisfy the frozen original schema. Existing fields and array
contents cannot change; only previously absent, schema-permitted clarification
fields can be added. The operation sends ordinary `SendMessage` with the original
Task ID and no payment header. It neither signs nor changes the budget. There are
at most ten rounds, each with a stable message ID and persistent deduplication.
If the response is lost, another round is blocked until `GetTask` contains the
original continuation message ID in Task history. An unrelated status change is
not evidence that the continuation was received.

## MPP and free offers

MPP uses the same ledger, preview tokens, caller ownership and cumulative USD
budget. Configure an `mpp` peer with `currency: "usd"`, an explicitly approved
Stripe merchant `recipient: "profile_..."`, a per-purchase limit in cents and a
matching cumulative USD budget. Sandbox recipients can use the documented
`profile_test_...` IDs. A buyer that has only MPP peers needs no EVM signer.
The built-in [Stripe SPT adapter](stripe-issuer.md) supplies token creation,
original-token recovery and independent seller-scoped receipt verification using
the public Stripe APIs. A custom authorized provider can still implement this
local interface:

```ts
mpp: {
  payer: 'your-stable-private-buyer-identity',
  mode: 'test', // explicitly select test or live
  paymentMethod: 'pm_authorized',
  createToken: async (operation) => { /* your authorized SPT provider */ },
  recoverToken: async (operation) => { /* read the original operation only */ },
  verifyReceipt: async (receipt, context) => { /* independent provider read */ },
}
```

`createToken` receives the stable `operationId`/`idempotencyKey`, purchase ID,
quote, mode and native SDK amount, currency, merchant `networkId`, expiry,
metadata and original payment method. It must create the scoped SPT for exactly
those conditions. The operation is persisted before the callback runs, and its
SPT is encrypted before any credential is sent. `recoverToken` may return the
original token or `undefined`; it must never create another one. Changing the
configured payment method does not alter an already started operation.

The official `mppx` Stripe client builds the native credential. Its
`Payment-Authorization` header coexists with the separate Bearer identity.
The provider verifier must independently match reference, amount, currency,
merchant/account, quote and test/live mode; a seller receipt alone keeps the USD
reservation unknown. Snapshots include the sanitized receipt, never the SPT.
The built-in adapter uses the public `issued_tokens` API; it does not create
accounts or collect/fund payment methods. Real test/live completion depends on
qualified accounts, API access and an owner-authorized payment source. Source
tests use simulated HTTP and do not prove that eligibility or a real charge.

### MPP customer authentication

For a purchase waiting on Stripe customer action, its original owner calls
`GET /management/v1/purchases/{id}/authentication` with the same Bearer identity
used to confirm it. The only input is the purchase UUID in the path; there is no
request body, query or caller-supplied operation ID. The management layer verifies
ownership and the frozen operation before reading the original token. Another
owner receives `404 purchase_not_found`.

The response is `{purchaseId, action: {type: "use_stripe_sdk", hashedValue,
publishableKey}}` or `{purchaseId, action: null}`. It is private and non-cacheable.
`action: null` means no supported action is currently required, not that the
purchase is paid. This GET cannot issue or confirm a payment, dispatch a task,
replay a credential or change the reserved/spent budget.

Configure the original issuer's optional `mppStripe.publishableKey` in the
`buyer-serve` credentials, using `pk_test_...` or `pk_live_...` matching its mode.
It is needed to return an action when a token has `requires_action`; a missing key
returns `stripe_publishable_key_required`. A mismatched key mode is rejected.
Purchases that require no customer action do not need this key.

The owner's web host can proxy the action route after authenticating the owner
and checking access to the original purchase. It loads official Stripe.js,
initializes `Stripe(action.publishableKey)` and calls
`stripe.handleNextAction({ hashedValue: action.hashedValue })`. Keep management
and Stripe secret keys on the private host and action values out of URLs, logs,
ordinary snapshots, receipts and Cards. The API does not itself display or
complete the customer's authentication.

After the customer successfully completes Stripe's interface, explicitly POST
`{}` to `/management/v1/purchases/{id}/recover` for the **same purchase** and read
its state. Neither a browser callback nor an action fetch marks the payment
confirmed: the original seller PaymentIntent must independently prove success,
amount, currency, mode and frozen order/quote bindings. A canceled or failed
authentication must not be presented as paid or replaced with a new purchase.
See [Stripe SPT setup and sandbox limits](stripe-issuer.md) for the full contract
and the distinction between granted-token helper tests and issuer 3DS acceptance.

### Free offers

A free-only policy can be configured without payment budgets:

```json
{
  "policyVersion": 1,
  "paymentsEnabled": false,
  "approval": "per_purchase",
  "peers": [{
    "id": "preview",
    "cardUrl": "https://seller.example/services/preview/v1/offers/free/agent-card.json",
    "protocol": "free",
    "currency": null,
    "recipient": null,
    "maxPerPurchase": "0"
  }],
  "budgets": []
}
```

This peer permits only explicitly advertised `free`/`none` offers. Preview reads
the Card and validates input without sending work. Confirmation sends the durable
original A2A request, with no signing, PSP operation or budget mutation. Payment
state is `not_required`; Task observation, original-request recovery and bounded
clarification work as for paid purchases. A surprise 402 never activates a payment
adapter. Paid peers still require their positive currency-specific budgets.

An optional `proveExpiredUnused(payload, requirements)` callback can establish that
the original EIP-3009 authorization expired without use at a canonical finalized
block. Only a true result, after receipt reconciliation remains unconfirmed, marks
the original attempt rejected and releases its reservation. The ledger retains
the original nonce, encrypted credential and the proof decision timestamp. A false
result, unavailable RPC or confirmed transfer cannot release that reservation.
This callback does not authorize a fresh nonce for an unknown purchase.
