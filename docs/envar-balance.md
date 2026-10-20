# Accept Envar account balance

This optional seller adapter accepts a captured Envar ledger claim for one immutable USD service quote. It is a platform-specific payment method. It does not produce an x402 USDC transfer or an MPP Stripe receipt. A buyer using Envar's account balance needs no local EnvarPay buyer wallet; the seller continues to run its own EnvarPay gate and private Agent.

## Seller setup

1. Connect the existing seller runtime to the intended Envar Agent with an owner-only `--envar-config` and `--envar-credentials` file. Keep the Agent-scoped Envar token separate from A2A caller tokens.
2. Add the exact approved `accountRef` to the local policy's `allowedBalanceAccounts`. Leave it empty to refuse all balance offers. Envar must independently verify that the reference belongs to this seller before publishing.
3. Add a service payment profile such as `{"adapter":"envar_balance","currency":"usd","accountRef":"seller-main"}` and a fixed or bounded quantity price. Its integer `amount` is **micro-USD** (100 = USD 0.0001), not USDC atomic units or Stripe cents. The maximum is a signed 64-bit amount.
4. Give the Envar platform a dedicated A2A caller token for this gateway. Platform ownership of an Agent does not automatically authorize calls to the seller's private Agent. For invitation-only offers, configure the corresponding access grant separately.
5. Publish only after the platform verifies the applied revision, public Card, unpaid HTTP 402 and receiving account. Funding the buyer balance, confirming a quote and starting a Task remain separate actions.

For a new A2A `SendMessage`, the gate returns HTTP 402 with the frozen quote and original Task ID when no `Envar-Balance-Claim` is supplied. The Envar platform reserves the buyer's balance after explicit authorization, then resends the same message ID with the original platform order ID and opaque claim token in `Envar-Balance-Order` and `Envar-Balance-Claim` headers. The seller uses its Agent-scoped Envar credential to claim that exact order. Envar atomically captures its reservation and returns a receipt bound to seller, service revision, input digest, message ID, quote ID, amount, currency and task ID. Only then does the gateway queue the private Agent task.

If the platform response is lost, the gate retains the original claim in its encrypted vault and retries that claim. It never asks for a replacement debit. A mismatched receipt, expired quote or unavailable platform blocks execution. Historical x402/MPP tasks keep their original recovery path; do not convert them to balance payments.

No seller payout is performed by this package. Envar owns the buyer balance and seller payable ledger, refund decisions and external settlement. Enable this adapter only after that platform path and the relevant merchant/PSP approval are ready.
