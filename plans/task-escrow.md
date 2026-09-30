# Task escrow candidate acceptance

Issue: https://github.com/EnvarAI/EnvarPay/issues/9

Ship only as an explicit experimental testnet feature after this candidate passes:

- [x] Preserve existing prepaid call behavior and separate task configuration.
- [x] Bounded HTTP task queue and existing runtime adapter; per-buyer access isolation.
- [x] Frozen terms, durable budgets, original signed transaction recovery, result commitment.
- [x] Local EVM success, reject, expiry, tamper, restart and real killed worker checks.
- [x] Candidate wheel/native framework task creation and evaluation: Hermes and Pydantic AI buyers to Hermes, local EVM.
- [x] Repeat native acceptance on the exact final wheel after follow-up fixes.
- [ ] Base Sepolia deploy, official USDC success/reject/expiry with exact receipt audits.
- [ ] Second RPC independently confirms canonical chain, escrow, amounts, roles and outcomes.
- [ ] CI and clean wheel installation on the final commit.

Keep mainnet rejected and signing/evaluator authority off by default. The immutable
prototype is version-pinned, not a declaration of ERC-8183 conformance or an audited
escrow product. Choosing a standards-compatible audited deployment is a separate
release gate before production funds, not something unit tests can establish.
