# Base Sepolia task acceptance

On 2026-10-01, the EnvarPay task candidate completed five public Base Sepolia
escrow cases using Circle's official test USDC. The independent audit verified
both transfers and the matching job event in each receipt on a second RPC.

Contract: [0x7001B9f1C7d3f7ef288aBAa6642715619122384d](https://sepolia.basescan.org/address/0x7001B9f1C7d3f7ef288aBAa6642715619122384d).
Buyer/evaluator: `0x1a98b778b60Acc15dFC50b0C33421f8759D71CfB`.
Provider: `0x01d232944a07Fc35d83621bbB4D727D758d10598`.
Each case funded 10000 atomic units (0.01 test USDC).

| Case | Result | Release or refund transaction |
| --- | --- | --- |
| Native Hermes → Hermes | Buyer inspected result, accepted, provider paid | [0x839476…](https://sepolia.basescan.org/tx/0x839476d8e6bd006d23c298a31bc22fae4b6aa79c95a7abfb0817091e0bec219a) |
| Deliberately wrong Hermes deliverable | Buyer rejected, full refund | [0x91b157…](https://sepolia.basescan.org/tx/0x91b15732bc7531866b01bdd6348acec386a69bda644e4db004b45076dd3cb62b) |
| Native Pydantic AI → Hermes | Original task resumed, accepted, provider paid | [0x725fe8…](https://sepolia.basescan.org/tx/0x725fe8e5d70d2e2609b1f5d4c1f508a887eeb88daf660c99e13ecf6cc5eba08e) |
| Disconnect before dispatch | Deadline expired, full refund, no seller execution | [0x891c41…](https://sepolia.basescan.org/tx/0x891c410f124fd1839ba179fc2089fba69f8b29198bb4e73336354a5bcd33a252) |
| Lost create receipt after real confirmation | Reused original signed transaction; one delivery and payout | [0xef8282…](https://sepolia.basescan.org/tx/0xef82825f2473e59b5d3c6684ba2ab90f3cae1439f6f4aada39c56ad22535adc7) |

Final official USDC balances: buyer **19.97**, provider **0.03**, escrow **0**.
Five fundings, three payouts and two refunds account for the original 20 test USDC.
Native seller execution records contain exactly four starts, one per dispatched job.
Completed-purchase and same-decision replay added no signature, execution or payout.

## Runtime and evidence boundaries

The native buyers called the candidate wheel's `create_task`, `task_result` and
`decide_task` MCP tools. HTTP task dispatch and settlement used production-candidate
EnvarPay code; the dedicated seller wrapper invoked real native Hermes. Hermes source
was `fc042f1d67bc393bf43920e92d4eb5082eddedfb` (2026.9.24), Pydantic AI 2.52.0,
model gpt-4.1-mini. Exact wheel digest and core commit are in
[run metadata](evidence/base-sepolia/run-metadata.json).

Pydantic AI initially stopped after observing `delivered` while on-chain submission
was pending. It did not accept a missing result. A follow-up run retrieved and accepted
that same task after confirmation, without creating or funding another task. This is
successful original-task continuation, not uninterrupted autonomous completion.

The recovery case explicitly injected receipt loss after an actual create transaction
confirmed. A separate operator script resumed the original task and deterministically
checked the real Hermes result before acceptance. It is not counted as another native
buyer-driven purchase. Expiry intentionally disconnected before HTTP dispatch; no
model or fake deliverable was used for that case.

`sepolia.base.org` sent transactions. `base-sepolia-rpc.publicnode.com` independently
checked canonical receipt blocks, confirmations, exact USDC Transfer amounts and
addresses, matching Funded/Completed/Rejected/Expired job events, frozen roles/terms,
and successful result commitments. See [complete audit](evidence/base-sepolia/independent-audit.json).
This was confirmation-depth validation, not a claim of finalized L1 economic finality.

The deployed escrow is the bytecode pinned in the tested wheel. Public RPCs briefly
returned a receipt before serving the corresponding numbered block during deployment;
the deploy example now waits for two confirmations and retries BlockNotFound without
signing a new transaction. That script-only fix and its tests do not change the tested
SDK or contract. No mainnet funds, token swaps or external paid faucet were used.

## Reproduction and remaining limits

Use the documented task configs and command sequence with fresh dedicated test keys,
a deployment of the exact pinned contract, and explicit testnet budgets. The published
status files include frozen request IDs, terms and receipts; never replay them as new
purchases or reuse someone else's signed transaction.

This accepts the experimental fixed-price task flow, not an audited general escrow
product or full ERC-8183 implementation. Neutral arbitration, milestones, arbitrary
asset networks, production reliability, and subjective output quality remain outside
this version. The earlier four-framework POC is separate evidence; this testnet run
covers Hermes and Pydantic AI buyers with a Hermes seller.
