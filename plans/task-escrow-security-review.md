# Task escrow independent security review handoff

Status: review package prepared; no independent contract security audit has been
commissioned or completed. This handoff does not authorize mainnet deployment,
signing, or removal of the existing network guard.

## Frozen candidate and reproduction

Review EnvarPay Python `0.1.0a11` at source commit
`a12dac13608f4350d9b9c6738cd75af969e26a6e`. The
[manifest](task-escrow-audit-manifest.json) pins the contract, packaged artifact,
compiler/dependency locks, wallet/queue code and tests by SHA256. Changes to these
inputs require an updated scope and review of their effects.

Clone at that exact commit. In an isolated environment, install `.[test,task]`,
then run:

```sh
npm ci --ignore-scripts --prefix contracts/task
npm run build --prefix contracts/task
git diff --exit-code -- src/envarpay/tasks/escrow.json contracts/task/MockUSDC.json
pytest -q tests/tasks/test_task_policy.py tests/tasks/test_deployment_wait.py
```

The [Task escrow CI workflow](../.github/workflows/task-escrow.yml) starts Ganache
on loopback with chain ID 31337 and runs the full `tests/tasks` suite, including
HTTP execution and a real killed worker. Reproduce those steps; do not point that
suite at a public funded wallet. Compilation uses Solidity 0.8.30, OpenZeppelin
5.4.0, optimizer 200 runs and Shanghai EVM. The manifest records the full compiler
version string.

## Review scope

- Review every contract transition, role check and deadline boundary, including
  complete/reject/refund races, duplicate IDs, reentrancy and reverted or
  non-exact token transfers. The immutable prototype has no admin, upgrade,
  fees, hooks or arbitration. It is inspired by ERC-8183; no conformance claim
  is made.
- Verify exact USDC custody and conservation across concurrent jobs. Consider
  paused/blocked token transfers, unsolicited transfers and a stuck token.
  Identify which risks need a different contract or an operational control.
- Review buyer/evaluator authority: the buyer can also be evaluator, an explicit
  trust choice with no independent dispute resolution. A submitted result hash
  alone does not prove quality or availability.
- Review frozen terms, peer/price limits, atomic budgets, original signed
  transaction recovery, receipt/bytecode/chain/role checks and canonical receipt
  assumptions. Lost responses or unknown outcomes must not release budgets or
  execute again without authoritative evidence.
- Review task and wallet HTTP/MCP authentication, per-client result isolation,
  bounded queues and worker restarts. Untrusted Agent execution/results cannot
  grant signing or evaluator authority. Keys remain with the isolated signer;
  Envar discovery is not spending approval.
- Review deployment verification, secret-file handling, journals, cumulative and
  gas limits, and the fail-closed network guard. Public signing accepts Base
  Sepolia only, with signing/evaluator authority off by default. An RPC URL
  change must not bypass chain, contract or token checks.

## Existing evidence and its limits

The [task guide](../docs/tasks/README.md),
[Base Sepolia acceptance](../docs/tasks/testnet-acceptance.md), and
[production-site API acceptance](../docs/tasks/site-acceptance.md) record
accept/payout, reject/refund, expiry, delivery and recovery. Second-RPC receipt
checks confirm recorded chain outcomes; they are not a contract security audit.
The cross-framework tool-payment matrix covers a different payment mode.

`docs/tasks/evidence/base-sepolia/deployment.json` identifies the testnet reference
deployment. Review runtime bytecode including immutable token substitution and
source/compiler inputs. Do not reuse the address on another chain or describe
this test deployment as a production contract.

## Independent deliverable

Require the scoped commit/files, methods, findings with severity and reproducible
exploit/test cases, trust assumptions, remediation commits, and independent retest
record. Fix and independently retest all critical/high findings. Any accepted
remaining finding needs an explicit owner, impact and documented operator
decision. Assess source/compiler changes after review for further review scope.

## Production release gates

1. The operator selects a qualified independent reviewer and agrees the scope
   and commissioning terms. No reviewer has been contacted or given private
   access by this handoff.
2. Complete review, remediation and retest. Select an audited contract design;
   document evaluator/dispute, expiry, token and upgrade assumptions before
   changing the test-only label.
3. Prepare a separate reviewed mainnet release with exact source/compiler,
   official token, bytecode, constructor arguments and chain ID. Add matching
   client allowlists, receipt checks and tests in a new PR. Preserve the current
   mainnet guard until that release has explicit approval.
4. Independently verify deployed code, token/roles, monitoring, recovery, key
   controls and gas/spending caps. Tests or a deployment transaction alone do
   not pass this gate.
5. Obtain separate approval for a bounded mainnet acceptance payment. Verify
   delivery and settlement/refund on the original IDs and publish operational
   limits before admitting production funds.

Current outcome: testnet task workflows have acceptance evidence. Mainnet task
escrow remains blocked on independent security review and a separate release.
