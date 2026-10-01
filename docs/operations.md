# Operating the payment services

Use a dedicated signer OS account or container with a private key and durable state
directory. An Agent receives only the authenticated wallet MCP endpoint and the
explicitly approved peer/tool/recipient/budget policy. Never share signing keys or
mount their directory into an Agent or EnvarLive executor. Protect state backups as
credentials, keep the same original directory when recovering, and never copy a
wallet to another host while both instances can sign.

Tool payments support the explicitly configured Base mainnet profile and official
USDC. Task escrow supports only official Base Sepolia test USDC. The bundled task
contract is unaudited and rejects mainnet; do not remove that guard as a release
shortcut. Chain receipts verify amounts and recipients, not subjective quality.

Run one seller worker and one state directory per signer. Multiple RPC callers on
the same host use the same transaction/process locks and ledger. There is no
multi-host nonce coordinator. Set explicit per-call/per-task, cumulative, gas and
deadline bounds; leave signing and evaluator flags off until the operator reviews
them. Grant evaluator authority only when accepting/rejecting results is intended.
An expired task can be refunded without evaluator authority, but still needs the
buyer's transaction-signing permission.

## Original-operation recovery

Retain request IDs and frozen terms. A lost response does not authorize another
purchase, nonce, deadline, decision or Agent execution. Inspect and recover the
original operation. Task transactions persist signed bytes before broadcast and
reuse those bytes after uncertainty. Deliverables must match their on-chain
commitment before acceptance. Accept/reject requires an explicit reason; a signed
decision cannot be silently replaced. Refund release returns budget only after the
full matching refund is independently verified.

The Envar task page restores task IDs and frozen arguments from the caller's durable
Invocation history. Reading wallet policy never creates or funds a task and does
not erase a completed/refunded task's terminal proof. Agent changes require a new
local allowlist review. Task receipts shown by this wallet are not independently
verified platform Transactions rows; keep that distinction in exported evidence.

## Required release checks

Verify normal execution/payout, rejection/full refund, expiry/full refund,
original-signature recovery after lost receipts, duplicate-ID replay and changed
terms refusal. Include process restart, concurrent submissions, queue limits,
credential isolation and a runtime failure with confirmed payment. For real-chain
acceptance, read canonical blocks and official-token Transfer plus the matching
authorization/job event from an independent RPC. Confirm signing/evaluator switches
are off at acceptance closure. Local EVM and mocked transport tests are separate
evidence from a public-chain payment and real native Agent delivery.
