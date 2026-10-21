# Stripe SPT buyer adapter

`createStripeMppBuyer` supplies the native MPP buyer's token creation, original
token recovery and independent receipt verification against published Stripe
APIs. It runs in the private buyer process and does not depend on Envar. It does
not collect card details, fund a wallet or create a payment method. The owner
must provide an already-authorized Stripe PaymentMethod and approved buyer policy.

The adapter supports upfront USD card charges from 50 to 99,999,999 cents. These
are integer cents, not dollars. Agent communication remains A2A; the native MPP
challenge and credential carry the payment authorization.

## Eligibility and credentials

Stripe's current [SPT country list](https://docs.stripe.com/agentic-commerce/concepts/shared-payment-tokens?agent-seller=agent)
applies to agents, customers and sellers. It includes the US, Canada and specified
European countries; Hong Kong is absent. Ordinary Stripe account activation does
not establish SPT eligibility. An eligible account must also have access to the
preview APIs. Live seller readiness requires enabled charges and an active card
payments capability. A real sandbox profile and matching test credentials are
checked independently; an inactive live account does not automatically block a
sandbox.

The issuer key creates/reads its own SPTs. Each seller also needs an explicitly
configured **seller-scoped read credential**, with permission to read its account,
business profile and PaymentIntents. An issuer credential does not automatically
have access to another merchant's PaymentIntent. This MVP verifier therefore needs
cooperating sellers; it does not claim arbitrary unconfigured Stripe merchants
can be independently verified. Use a restricted seller key where its preview
permissions allow these reads. Never place either key in a prompt, Agent Card,
browser bundle, public configuration or source control.

The adapter verifies the seller account/profile binding with the documented
[`GET /v2/network/business_profiles/me`](https://docs.stripe.com/api/v2/network/business-profiles/retrieve-network-business-profile-me?api-version=2026-09-30.preview)
under the same account-scoped credential used for account and payment reads.
Sandbox IDs such as `profile_test_...` are supported. This is provider evidence,
not an owner assertion that an arbitrary profile belongs to an account.

## SDK setup

```ts
import { createStripeMppBuyer } from '@envarai/envarpay/mpp';
import { CredentialVault } from '@envarai/envarpay/server';

// Load these values from an owner-only credential file, not an Agent prompt.
const vault = new CredentialVault('./private/authorizations', vaultKey32Bytes);
const mpp = createStripeMppBuyer({
  payer: 'my-private-buyer',
  mode: 'test',
  issuerAccountId: 'acct_ISSUER',
  secretKey: issuerSecretKey,
  publishableKey: issuerPublishableKey, // Optional until owner authentication is needed.
  paymentMethod: ownerApprovedPaymentMethod,
  sellers: {
    profile_test_SELLER: {
      accountId: 'acct_SELLER',
      secretKey: sellerRestrictedReadKey,
    },
  },
  returnUrl: 'https://buyer.example/stripe-return',
}, {
  statePath: './private/stripe-issuer.sqlite3',
  vault,
});

await mpp.assertReady(); // Account/profile GETs only; does not issue or charge.
// Pass mpp and the same vault to CommerceBuyer with a reviewed USD buyer policy.
// Shut down the buyer's in-flight work before calling mpp.close().
```

For `buyer-serve`, put the equivalent settings under `mppStripe` in its private
credentials JSON. The CLI reads secret files itself; no custom adapter module is
required for this official Stripe flow:

```json
{
  "callers": { "OWNER_MANAGEMENT_TOKEN": "owner" },
  "peerTokens": { "seller": "SELLER_AUTH_TOKEN" },
  "vaultKeyFile": "./private/vault.key",
  "mppStripe": {
    "payer": "my-private-buyer",
    "mode": "test",
    "issuerAccountId": "acct_ISSUER",
    "secretKeyFile": "./private/stripe-issuer.key",
    "publishableKey": "pk_test_ISSUER",
    "paymentMethod": "pm_AUTHORIZED",
    "sellers": {
      "profile_test_SELLER": {
        "accountId": "acct_SELLER",
        "secretKeyFile": "./private/stripe-seller-read.key"
      }
    },
    "returnUrl": "https://buyer.example/stripe-return"
  }
}
```

Replace the identifiers and tokens with owner-approved values, protect the
credentials and secret files with mode `0600`, and pair this with an MPP peer and
explicit USD budget in the buyer policy. `vault.key` contains 32 raw bytes. The
issuer ledger is derived from the buyer `--state` path by appending
`.stripe-issuer.sqlite3`; it shares the buyer's encrypted authorization vault.
`mppStripe` and `mppAdapterModule` are mutually exclusive. Starting the service
checks readiness but never creates a token; a reviewed buyer purchase does that.
`publishableKey` is optional for purchases that need no customer action. When
configured, it must be a `pk_test_...` or `pk_live_...` key matching the issuer's
mode. Use the original issuer account's publishable key. The owner-authenticated
management action route requires it when the original token is in
`requires_action`; an omitted key produces `stripe_publishable_key_required`
without issuing a replacement token.

The normal mode calls
[`POST /v1/shared_payment/issued_tokens`](https://docs.stripe.com/api/shared-payment/issued-token/create?api-version=2026-09-30.preview)
in either test or live mode. The frozen local purchase determines all financial
scope:

```text
payment_method                         = owner-approved original PaymentMethod
seller_details[network_business_profile] = original quote recipient
usage_limits[currency]                 = usd
usage_limits[max_amount]               = original amount in integer cents
usage_limits[expires_at]               = original quote expiry
shared_metadata[envarpay_operation]    = original token operation ID
shared_metadata[envarpay_purchase]     = private buyer purchase ID
shared_metadata[envarpay_order]        = original seller order ID
shared_metadata[envarpay_quote]        = original quote ID
shared_metadata[envarpay_terms]        = original frozen terms digest
```

Metadata is not a new payment protocol. It binds the provider record to the
already-frozen purchase for reconciliation. The local issuer ledger and vault
must survive process restarts. One process owns each ledger; memory-only issuer
state is refused. Token, profile and PaymentIntent APIs share the public
`2026-09-30.preview` pin with the seller adapter. Do not change this version
independently of the seller PaymentIntent mapping and its contract tests.

## Explicit real Stripe sandbox helper

For seller sandbox acceptance, choose `issuance: 'test-helper'`, `mode: 'test'`
and one of these explicitly allowed PaymentMethods from Stripe's
[official testing guide](https://docs.stripe.com/testing?testing-method=payment-methods):

| PaymentMethod | Stripe's general test behavior |
| --- | --- |
| `pm_card_visa` | Successful Visa payment. |
| `pm_card_visa_chargeDeclined` | Generic card decline. |
| `pm_card_authenticationRequired` | Authentication required for every transaction. |

Only this explicit helper accepts these test aliases; normal issued-token mode
uses an actual owner-approved `pm_...` object. The issuer account must be the same
account as the configured seller. The adapter then uses the official
[`POST /v1/test_helpers/shared_payment/granted_tokens`](https://docs.stripe.com/api/shared-payment/granted-token/create?api-version=2026-09-30.preview)
and reads the original granted token on recovery.

This helper simulates a token received by that test seller. Its response does not
contain the original PaymentMethod ID or seller-details fields. The adapter binds
the outgoing test request, the independently checked seller account/profile,
returned card type, mode, metadata and exact usage limits. It does not invent
missing response fields or claim this helper proves live issuer eligibility.
The helper is never selected after an issued-token API failure, and cannot run
with a live key. An actual Stripe sandbox run is separate evidence from mocked
HTTP contract tests; neither proves a live card charge.

Stripe's general test-card behavior is not an SPT-specific acceptance result.
Record the actual helper and PaymentIntent responses for each scenario. A decline
must not dispatch a task or mark the budget spent; an unresolved provider outcome
keeps its reservation until independently reconciled. A granted token has no
documented issued-token `status`/`next_action`, so selecting
`pm_card_authenticationRequired` in the helper does not prove issuer 3DS. That
acceptance needs normal test-mode `issued_tokens` access, an actual test
PaymentMethod with the intended authentication behavior, and the owner browser
flow below against the original issued token.

## Original-operation recovery and customer action

```mermaid
sequenceDiagram
    participant O as Owner browser
    participant B as Private buyer
    participant L as Issuer ledger and encrypted vault
    participant I as Stripe issuer API
    participant S as Paid A2A seller
    B->>L: Persist original request and idempotency key
    B->>I: Create exactly scoped SPT
    I-->>B: Original SPT ID and status
    B->>L: Encrypt original ID before returning it
    alt Active and unused
        B->>S: Original MPP credential
        S-->>B: Receipt and task result
        B->>I: Read PaymentIntent using seller read credential
    else Customer action required
        B-->>O: Purchase requires authentication
        O->>B: GET original purchase authentication
        B->>I: GET original SPT
        B-->>O: Original Stripe.js action
        O->>O: Complete Stripe.js authentication
        O->>B: Explicit recovery of same purchase
        B->>I: GET original SPT
    end
```

Known token IDs recover through `GET /v1/shared_payment/issued_tokens/{id}` (or the
corresponding granted-token GET for the explicit helper). Amount, currency,
merchant, original PaymentMethod, mode, expiry and metadata must still match.
An active token must be independently shown unused and unexpired before it is
returned for credential preparation.

If token creation loses its response before the ID is saved, the operation stays
unknown and its budget remains reserved. This adapter does **not** retry POST,
issue a replacement token or invent a list/search endpoint. Stripe may prune
[idempotency keys after 24 hours](https://docs.stripe.com/api/idempotent_requests),
so blindly replaying an old key is unsafe. Preserve the original ledger and
resolve its existing issuance with the provider; do not create a new purchase
to bypass the uncertainty.

`stripe_spt_requires_action` means the original SPT needs customer authentication.
The private SDK `authenticationAction(operationId)` accessor retrieves that same
SPT. CLI hosts use the purchase-scoped owner route instead:

```http
GET /management/v1/purchases/{purchaseId}/authentication
Authorization: Bearer OWNER_MANAGEMENT_TOKEN
```

Pass the original purchase UUID, with no body, query parameters or arbitrary
operation ID. The route checks the authenticated caller's ownership and the
original purchase, operation, quote and mode bindings before provider access.
It only reads the existing token; it cannot issue a token, create or confirm a
PaymentIntent, replay payment credentials, dispatch work, change a budget or mark
the purchase paid. Responses use `Cache-Control: no-store` and
`X-Content-Type-Options: nosniff`:

```json
{
  "purchaseId": "ORIGINAL_PURCHASE_UUID",
  "action": {
    "type": "use_stripe_sdk",
    "hashedValue": "OPAQUE_ORIGINAL_TOKEN_ACTION",
    "publishableKey": "pk_test_ISSUER"
  }
}
```

The other successful response is `{ "purchaseId": "ORIGINAL_PURCHASE_UUID",
"action": null }`. It means no supported authentication action is currently
required; it does not mean payment succeeded. Missing authentication returns
`401 authentication_required`; a missing purchase or another owner's purchase
returns `404 purchase_not_found`. Configuration, unsupported action, missing or
mismatched original operation, and changed-policy errors return `400` and require
resolution against the same purchase.

The owner's web host may proxy this GET after checking access to that purchase.
Load [official Stripe.js](https://docs.stripe.com/js/including), initialize it with
`Stripe(action.publishableKey)`, and pass the opaque value to
`stripe.handleNextAction({ hashedValue: action.hashedValue })`, as documented in
Stripe's [SPT agent integration](https://docs.stripe.com/agentic-commerce/concepts/shared-payment-tokens?agent-seller=agent).
Do not decode the value or put it in ordinary snapshots, Agent Cards, receipts,
URLs or logs. Management Bearer and Stripe secret keys stay in the private host.
This API supplies the browser action; the host must present Stripe's authentication
interface to the owner. Unsupported action types stay blocked.

After Stripe.js finishes successfully, explicitly call
`POST /management/v1/purchases/{purchaseId}/recover` with `{}` for the **same
purchase**, then read its state. Cancellation or an authentication error is not a
successful payment. A callback, an action fetch or `action: null` never completes
authentication or payment locally, and does not authorize a substitute SPT or
purchase. Recovery verifies the original provider state before continuing.

Payment receipt verification reads the original PaymentIntent under the explicit
seller account and profile. It checks succeeded status, full received amount,
currency, mode, seller order, quote and terms digest. A seller-supplied receipt,
an issued token, or a successful authentication callback alone does not mark the
buyer budget spent.

## Verification scope

`commerce-stripe-issuer.test.mjs` uses an injected HTTP fixture to verify official
request shapes, independent account/profile checks, encrypted persistence, restart,
lost responses, scope mismatch, customer action, test-helper isolation, receipt
binding, bounded transport and duplicate-operation prevention. These tests never
call live Stripe, create real tokens or consume funds. Record authorized real
sandbox and live acceptance separately from these source-level guarantees.
