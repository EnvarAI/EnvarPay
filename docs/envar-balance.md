# Envar account-balance seller gate

EnvarPay accepts a captured Envar ledger claim for one immutable USD service quote. The buyer uses the Envar Wallet and needs no local payment software. The seller keeps its Agent, model, memory, tools, and EnvarPay process in its own environment.

## Seller checklist

1. Create a private Agent in Envar, select Hermes or OpenClaw, and download the Agent-specific setup file.
2. Run `envarpay setup --file ...` beside that Agent. Start the generated service and keep its HTTPS endpoint online. Import `connection.json` in Envar and pass **Check connection** with a real final Agent reply.
3. Open the Agent's **Services** page. Choose an installed text Skill, enter its input/delivery description, and set a USD price. Setup already allows the local receiving reference `envar`; Envar must separately show that this seller is approved to receive account-balance payments.
4. Select **Test service**. Envar compares the applied service version with the live unpaid quote, including the amount, currency, receiving reference, input digest, and Task ID.
5. Publish only after the connection, receiving approval, and service test all pass. A private or unlisted service still needs its normal access grant.

If receiving approval is pending, the service remains a draft. Do not edit private credentials to work around the status. Free services can be published without balance approval.

## Original order behavior

For a new paid `SendMessage`, the seller gate returns HTTP 402 with the exact quote and original Task ID. After the account owner confirms the purchase in Envar, the platform reserves the buyer's balance and retries the **same** message ID with the original order ID and short-lived claim token. The seller calls Envar's authenticated claim API. Envar atomically captures the reservation and returns a receipt bound to seller, service revision, input digest, message ID, quote ID, amount, currency, and Task ID. The gate verifies that receipt before queuing the private Agent task.

If the claim response is lost, the gate retains the original claim in its encrypted vault and retries that claim. A mismatched receipt, expired quote, or unavailable platform blocks execution. It never asks the buyer to create a replacement payment. Completed payment and Agent execution have separate states; an execution failure does not silently undo the payment.

Amounts in the seller config and claim are **micro-USD**: `100` is USD 0.0001 and `100000` is USD 0.10. Seller earnings begin as pending in Envar; Envar, not this package, controls refund decisions and later settlement. The production Wallet remains gated until real top-up, refund, and seller-settlement checks pass.

## Public claim contract

The seller calls `POST /api/v1/commerce/payment-claims/{order_id}/claim` with its dedicated seller credential and `Idempotency-Key: {order_id}`. Native inbox connection credentials cannot call this legacy seller claim endpoint. The JSON body is defined by `packages/typescript/schemas/balance-claim.v1.schema.json`; the captured response uses `balance-receipt.v1.schema.json`.

The body sends the original claim token plus task, quote, message, service revision, offer, input/terms digests, amount, currency and recipient. The response repeats those terms and adds the platform order ID and `economic_id: ledger:UUID`. Validate both shape and exact identity against the frozen quote; HTTP 200 or `state: captured` alone is insufficient. A lost response retries only the original claim. `digest-vectors.json` defines canonical JSON/SHA-256 examples shared with the platform; amounts remain integer strings.

These schemas describe the existing seller API; they do not change wallet authority or introduce new payment methods.
