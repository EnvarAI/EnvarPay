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

### Local aggregate alerts

The owner can read aggregate signals without opening a signer/vault, changing any
budget or contacting Envar, an Agent or a payment provider:

```sh
envarpay inspect --state /private/envarpay/buyer.sqlite3 --alerts \
  --config /private/envarpay/buyer-policy.json --no-integration --fail-on-alert
envarpay inspect --state /private/envarpay/seller.sqlite3 --alerts \
  --integration-state /private/envarpay/envar-state/integration.sqlite --fail-on-alert
```

Use the policy actually loaded by the buyer. Limits are not stored in its ledger,
so omitting or supplying an unreadable/incompatible policy makes budget signals
`unavailable`; the command does not infer a limit from a balance. A policy whose
currencies omit any spent/reserved ledger currency also leaves budgets unavailable.
The command cannot prove that a file matches a running process's loaded policy.
Restart/configuration management and the owner must establish that binding.

Supply the actual optional integration ledger to observe pending reports and
acknowledgments. Use `--no-integration` only when that runtime has no Envar
integration configured; those two signals are then `not_applicable`. Omitting
both options means they are `unavailable`, not zero. They cannot be combined.

Output has a finite `signals` list, integer counts, severity and `clear`, `alert`,
`unavailable` or `not_applicable` status. It includes no purchase, caller, event,
wallet or account IDs, URLs, prompts, raw provider messages or credential paths.
Budget entries use only the fixed units `usd_cents`, `base_usdc_atomic` and
`base_sepolia_usdc_atomic`, with exact integer-string limits/spent/reserved/remaining.
All monetary arithmetic uses BigInt; no FX conversion or floating-point rounding.

| Signal | Meaning of an alert |
| --- | --- |
| `payment_unknown` | At least one persisted payment remains unknown. |
| `execution_unknown` | At least one persisted task execution remains unknown. |
| `recorded_provider_failure` | A pending buyer record has a recognized Stripe transport/request/response error, or a seller attempt contains an explicitly unsuccessful x402 receipt with an error reason. |
| `budget_near_limit` | Reserved plus spent is at least90% but below the supplied cumulative limit. |
| `budget_exhausted` | Reserved plus spent is at or above the supplied limit; critical severity. |
| `report_backlog` | The integration outbox has pending reports or application acknowledgments. |
| `report_failure` | A pending outbox event has a recorded failed delivery attempt. |

`ledger_read` is clear when the recognized private ledger can be read; corrupt,
missing, wrong-version or unsafe files produce unavailable signals. All sources
must be regular owner-only files owned by the invoking OS user. Symlinks are
refused. Each database is read under a query-only transaction; sources are separate
snapshots, not a cross-database atomic snapshot. SQLite may update transient WAL
reader marks in shared memory; no ledger/payment/outbox/budget rows are changed.

This is **local persisted evidence**, not a live provider-health probe. A generic
unknown outcome or empty receipt does not prove provider failure; conversely no
recorded error does not prove the provider is healthy. `providerHealth` is always
`unavailable_not_probed`. Report backlog may be normal briefly; use repeat samples
and your operational threshold before paging. Application/quote publication
digest mismatches and platform observer alerts belong to Envar's monitoring;
the independent wallet does not read or fabricate those platform facts.

Without `--fail-on-alert` inspection prints JSON and exits0 even when its report
is partial. With it, exit0 means all applicable local signals are available and
clear, exit2 means at least one alert, and exit3 means a requested source is
unavailable (which takes precedence over exit2). Invalid CLI combinations exit1.
The JSON includes `recommendedExitCode` in either mode. Operators can schedule
this explicit command in their existing local monitor and route nonzero status;
no scheduler, daemon, external message or public wallet endpoint is installed.

Alerts never authorize retry, payment, refund or budget release. Use the original
owner recovery workflow to reconcile unknown records and preserve spent history.
`paymentPerformed:false`, `refundPerformed:false`, `networkRequests:0` are explicit.

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

The buyer contention test confirms100 distinct purchase IDs concurrently against
one real SQLite budget. Thirteen fit;87 are rejected before signing. Seven
independently accepted synthetic receipts become spent and six remain unknown
and reserved. Restart/recovery retains the same thirteen nonces and credentials,
with no extra signature/settlement or budget overshoot. A separate source-transport
test denies all ambient network access and every Envar domain while the independent
purchase and original recovery use only the explicitly injected peer. These tests
use synthetic financial and task fixtures; they do not add real purchases to the
eight separate native/chain acceptance records.
