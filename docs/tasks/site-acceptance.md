# Production-site task acceptance

On 2026-10-02, real Envar SSO accounts used the deployed website API to invoke
an operator-owned task wallet, with a real Hermes seller on Base Sepolia. Each
case funded 10000 atomic units (0.01 official test USDC) in the pinned experimental
contract. These are public-chain payments and actual native delivery, separate
from browser fixtures and local EVM tests.

| Case | Chain result | Settlement transaction | Native executions |
|---|---|---|---|
| Correct delivery, original receipt recovery, explicit acceptance | Completed; provider paid | [0x426c1483…](https://sepolia.basescan.org/tx/0x426c1483f6f1585018deee29b17026d9364260761449759daa7146030092f47d) | 1 |
| Deliberately wrong delivery, explicit rejection | Rejected; full buyer refund | [0x7fc8b857…](https://sepolia.basescan.org/tx/0x7fc8b85718bc209eff384d1bc181d3f7646148a33aa3122db08f10a290948942) | 1 |
| Disconnect after funding and before seller admission, deadline refund | Expired; full buyer refund | [0xfccc80b5…](https://sepolia.basescan.org/tx/0xfccc80b564b68c248f85e82c1e554af867b2547a7ce4b8ec0caa839bce2440ec) | 0 |

The SDK verified each exact official USDC Transfer, frozen roles/amount/terms and
canonical receipt. A second RPC (`base-sepolia-rpc.publicnode.com`) independently
checked all six funding/settlement transfers and terminal contract states.
Buyer balance changed from 19.97 to 19.96 test USDC, provider from 0.03 to 0.04,
and escrow ended at zero. [Public receipt evidence](evidence/production-site-20261002.json)
contains transaction hashes and execution counts, never keys or signed bytes.

The receipt-loss case deliberately removed an earlier local create receipt after
real funding and delivery. Version 0.1.0a8 returned the advanced job state while
leaving that original receipt unresolved. The 0.1.0a9 fix reconciled the original
transaction without changing its hash, signature, job ID or result. A temporary
service-start response loss was recovered using the same task ID. The production
website returned the same invocation on repeated creation; no second payment or
native execution occurred.

A separate initial expiry fixture failed before signing because the preceding
injected receipt was unresolved. It has no chain job or signed transaction and
is retained as a failed attempt, not counted as a refund success. A concurrent
recovery attempt was refused by the signer lock; its original task was then
recovered after the active decision finished. No replacement task was created for
the delivery or rejection cases.

The seller used the existing native Hermes installation and reviewed
gpt-4.1-mini profile. Its tools were disabled for these bounded answer fixtures.
A separate actual inference succeeded under a macOS kernel sandbox that denied
reading the signer canary and personal files. Production deployment still requires
each operator to enforce the documented separate runtime and wallet identities.

This proves website-API funding, delivery inspection, payout, rejection, expiry
refund, original receipt recovery and duplicate prevention. The focused browser
suite separately tests form restoration and decisions. A physical browser reload,
microphone, screen capture or EnvarLive avatar is not implied by these API cases.
Task escrow remains unaudited and Base Sepolia-only; its mainnet guard remains on.
