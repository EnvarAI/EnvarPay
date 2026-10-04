# Operating and recovering the commerce runtime

Run one process per SQLite ledger. Preserve the original runtime version, service
revisions, task IDs, payment references and encrypted authorizations when restarting
or upgrading. A process restart is not permission to create another purchase.

## Inspect pending work

The local owner can inspect an existing buyer or seller ledger without opening a
signer, reading its vault or contacting a provider:

```sh
envarpay inspect --state /private/envarpay/seller.sqlite3 --after 0 --limit 100
envarpay inspect --state /private/envarpay/buyer.sqlite3 --after 0 --limit 100
```

The file must be a regular, owner-only file owned by the current OS user. Symlinks
and unsupported schemas are rejected. Output includes the ledger role, total and
attention counts, bounded original purchase/order IDs, payment/execution states
and known Task IDs. It omits prompts, wallet keys, authorizations, vault paths and
tokens. When `hasMore` is true, use the returned `nextCursor` as `--after` to read
the next page. A buyer item may be normally submitted work still awaiting its
result; an attention item does not imply that payment failed.

`inspect` is read-only. It does not confirm, retry, cancel, refund or release a
budget reservation. Preserve the original IDs before using the owner-authenticated
[buyer recovery operation](a2a-buyer.md#payment-and-recovery-facts). A confirmed
payment and an unknown execution are separate facts. If the remote Task ID is
known, [seller recovery](a2a-runtime-recovery.md) reads that original Task. A lost
dispatch with no safe remote lookup stays unknown; never repair it by blindly
sending a new task. A [standard third-party peer](a2a-standard-peers.md) does not
implicitly promise idempotent `SendMessage`, so ambiguous paid sends are not
reposted.

## Review paid work that failed

Use the same local owner-only inspection with `--refund-review` to find original
purchases or seller orders whose payment is confirmed and execution ended in
failure:

```sh
envarpay inspect --state /private/envarpay/seller.sqlite3 --refund-review --after 0 --limit 100
envarpay inspect --state /private/envarpay/buyer.sqlite3 --refund-review --after 0 --limit 100
```

Each candidate includes the original ID, payment/execution states, known Task ID
and `reason: "confirmed_payment_failed_execution"`. A native Task that ended
failed, canceled or rejected is represented by the runtime's terminal `failed`
execution state. Free work, rejected or unknown payments, completed work and
nonterminal execution are excluded. Unknown operations remain in the default
attention view and must first be reconciled against their original evidence.

`view` identifies the selected list. `refundReviewCount` counts candidates in the
whole ledger, while `attentionCount` retains the default pending/unknown count;
`total` is the number of all orders or purchases. These counts do not shrink as
you page with `nextCursor`. Without `--refund-review`, the existing attention
items and pagination are unchanged. No prompts, payment credentials, vault paths
or provider secrets are included in either view.

This is a **manual review candidate**, not a refund entitlement or a statement
that money was returned. Review the original terms, Task outcome and independently
verified payment before deciding what to do. The list does not track review
decisions or external refund status; a candidate may remain listed after an
external resolution. Preserve that separate evidence with the original ID.

Both `paymentPerformed` and `refundPerformed` are `false`. Inspection does not
contact a provider, open a vault/signer, issue a refund, alter payment state,
release a buyer budget or retry execution. Actual refund handling and its
provider reconciliation are outside this inspection command. Never delete the
ledger, reset spent budget or create a replacement purchase to resolve a candidate.

## Health and readiness

Seller `GET /healthz` reports process liveness and whether shutdown has begun.
`GET /readyz` also checks the local ledger schema/readability and a latched fatal worker failure.
An unavailable store or fatal worker error returns 503; shutdown reports draining.
Responses contain stable status values rather than internal database errors.

These probes do not verify that an external Agent, RPC, facilitator or Stripe
account is currently reachable. Provider capability checks at startup and exact
per-purchase payment verification serve different purposes. Monitor original
unknown payments, unknown executions, reserved budgets and repeated provider
errors along with local readiness. An HTTP 200 health response does not establish
successful delivery or money received.

## Consistent offline backup

Use a dedicated private backup location and encryption at rest. Keep access at
least as restrictive as the source: runtime directories `0700`, credential/key and
ledger files `0600`, with the runtime's intended OS owner. Never put an unencrypted
backup containing wallet or provider credentials in a repository or public bucket.

1. Stop admitting purchases and shut down **every process owning the affected
   buyer, seller, proxy and integration stores**. Let the runtime drain, and verify
   the processes exited. Do not copy a live SQLite database file by itself.
2. Preserve the complete private runtime directories together: configuration and
   immutable service history, buyer/seller databases and any remaining WAL/SHM
   files, encrypted authorization directories and their original vault keys,
   signer/provider credential references and the referenced private material,
   `upstream-bindings.json`, peer-proxy state, and Envar integration state/config
   directories. Also retain the exact package/image version and launch settings.
3. Copy the stopped directory set as one backup generation. Record a manifest of
   file hashes and the backup time in the private backup location. Verify file
   completeness, ownership, permissions and decryptability using a separate
   restore location. Do not start both original and restored signers.
4. Keep signing disabled during restore validation. Open the restored ledger with
   the matching runtime, inspect original IDs and unknown states, and compare
   budgets, payment references and saved results. Reconcile the original chain or
   PSP operations against the backup time before accepting new purchases.

Restoring an older budget ledger can omit payments made since the backup. Current
wallet balance is not enough to reconstruct its cumulative spending policy. Do
not reset the ledger or overwrite the newest state to regain spending capacity.
Keep later records and reconcile their original transactions before resuming.
If required files, credentials or original references are missing, preserve the
backup and stop new signing until the inconsistency is resolved.

## What the fault tests establish

`packages/typescript/test/commerce-fault-process.test.mjs` launches real Node
children, waits for an IPC checkpoint after a durable product-store operation,
then sends `SIGKILL`. It covers a reserved seller payment, persisted buyer
authorization/budget, confirmed payment plus atomic Task/outbox, claimed dispatch,
and a saved remote Task. The tests reopen the real SQLite/vault files and check
original identity, paid-first dispatch, retained unknown state and no blind rerun.
The offline restore test copies stopped seller/buyer ledgers, their private keys
and vaults, configuration and upstream bindings, checks the copied file hashes,
and reads the original completed result without another execution.

Settlement receipts, signatures and executors in these tests are synthetic. The
tests establish actual OS-process termination and local disk recovery at the
named boundaries; they do not establish real chain/PSP payment, model execution,
power-loss behavior, an atomic filesystem-wide snapshot or every instruction-level
crash window. Native Agent and real payment acceptance remain separate evidence.
No full A2A TCK certification is claimed.
