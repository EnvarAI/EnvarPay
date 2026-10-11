# Envar balance payments

The experimental `envar/charge` MPP method buys an A2A task with an explicitly
authorized CNY wallet balance. Amounts use integer fen: `"500"` means CNY 5.
This mode needs an Envar wallet and an active merchant; free, x402 USDC and
MPP Stripe offers retain their independent setup and recovery paths.

The wallet issuer is operator configured. The client never selects a wallet
server from untrusted seller metadata, changes currency, or falls back to a
different payment method. The method is an Envar extension, not a registered
method supported automatically by every MPP client.

## Seller profile

Create a separate offer and Card for CNY. For example:

```json
{
  "adapter": "mpp",
  "method": "envar",
  "intent": "charge",
  "currency": "cny",
  "accountRef": "wallet",
  "merchantId": "11111111-1111-4111-8111-111111111111",
  "issuer": "https://wallet.example.com",
  "environment": "sandbox",
  "methodVersion": "1"
}
```

These are placeholders. Configure an issuer running the Envar wallet API and
have the exact A2A endpoint verified for the actual merchant. Publication probes
only register an unpaid challenge; no grant or balance is consumed.

The seller CLI credentials file supports:

```json
{
  "callers": {},
  "upstreams": {},
  "vaultKeyFile": "private/vault.key",
  "mppHmacKeyFile": "private/challenge.key",
  "wallets": {
    "wallet": {
      "issuer": "https://wallet.example.com",
      "environment": "sandbox",
      "merchant": "11111111-1111-4111-8111-111111111111",
      "credentialFile": "private/merchant.token"
    }
  }
}
```

Configure the actual upstream credentials separately. Private credential files
must be owner-only. Run the normal `envarpay serve` command with this file and the
seller configuration. Different MPP methods route to separate gates; a wallet
offer does not require a Stripe key or EVM signing key.

An explicitly configured ordinary `callers` token can still perform an unpaid
publication probe. It does not gain wallet authority: central reserve/redeem must
match the grant's separate merchant-scoped buyer identity before any paid task.

SDK integrations import `EnvarWalletGate` and `EnvarMerchantClient` from
`@envarai/envarpay/wallet`. Use the merchant client's `authenticator()` for the
wallet A2A route and the gate as the `CommerceServer` payment gate. Start the
gate's completion reconciler with `start()` and await `stop()` before closing the
local store. Completed task notifications survive restart in the seller store.

## Buyer setup

Approve a bounded SpendGrant in Envar and put its credential in a private file.
The buyer policy must explicitly select `protocol: "mpp"`, `method: "envar"`,
`currency: "cny"`, the issuer/environment and the merchant UUID as `recipient`.
Keep the usual explicit per-purchase and cumulative local budget; the central
wallet independently enforces the grant and shared available balance.

Add this section to the private buyer CLI credentials file:

```json
{
  "wallet": {
    "issuer": "https://wallet.example.com",
    "environment": "sandbox",
    "principal": "the-principal-returned-by-the-grant",
    "credentialFile": "private/spend.token"
  }
}
```

Also configure the local owner-management credential and vault key as described
in [buyer setup](a2a-buyer.md). Wallet peer identity tokens are issued separately;
the spending credential is never forwarded to a seller. In SDK use, pass an
`EnvarWalletClient` as `CommerceBuyerOptions.wallet`. The `./wallet` entry point
also exports the MPP method for clients that do not use `CommerceBuyer`.

Loopback HTTP is allowed only for explicitly selected sandbox wallet peers.
Live issuers and peers require HTTPS. Sandbox and live payments cannot share a
funding credential or be automatically converted.

## Recovery, completion and refunds

EnvarPay persists the original request, challenge and reserve operation before
submitting a payment. A lost reserve response is recovered by querying that
operation. A lost paid response reuses the exact original request and credential;
the wallet and seller preserve the original charge and Task. Unpaid wallet
previews use a stable JSON-RPC ID and canonical request bytes, so losing the
first 402 does not force a new purchase.

The server confirms capture independently with the wallet before creating its
Task/outbox. A receipt is evidence of capture, not proof of satisfactory work,
bank settlement or present-day refund status. Completion is notified separately;
merchant earnings release follows the wallet's frozen settlement policy.

Use `EnvarWalletGate.refund(orderId, caller, amount, reason, key)` for a merchant
refund. It durably blocks new local dispatch before requesting the central
refund, and rejects running/unknown work for operator review. Existing Task reads
remain owner scoped. The same payment or old receipt cannot start another task.
Refunds do not restore an Agent's gross spending budget.

Optional Envar configuration synchronization uses `allowedEnvarWallets` entries
containing `accountRef`, `merchantId`, `issuer` and `environment`. Existing
`allowedMppAccounts` authorize Stripe accounts only. Report wallet payments with
`enqueueWalletPayment`; neither configuration synchronization nor a report
grants permission to spend.

## Validation boundary

The normal `npm test` discovery covers native SDK challenge/credential exchange,
independent wallet receipts, identity separation, lost responses and restart,
invalid grants, tampering and refund dispatch protection. SDK tests use a local
wallet fixture and deterministic A2A executor, without real money. Actual
PostgreSQL and HTTP/browser acceptance belongs to the coordinated Envar sandbox
environment; live payment-channel activation is separate.
