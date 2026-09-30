# Experimental task escrow

Task mode adds a fixed-price asynchronous job to EnvarPay: the buyer locks funds,
the provider executes and commits its deliverable, and the buyer explicitly accepts
or rejects it. Acceptance releases escrow; rejection or expiry refunds the buyer.
Existing `call`, x402 wire formats and `init --mode private/seller` keep their meaning.

This branch is a candidate implementation. Public Base Sepolia and current-candidate
native-agent acceptance must pass before release. The bundled immutable contract is
experimental, not audited or a claim of full ERC-8183 compatibility. Mainnet is rejected.

## Installation and roles

Install the candidate source with `pip install -e '.[task]'`, or install a built wheel
with its `task` extra. Web3 is an optional dependency. This does not imply the candidate
has been published to PyPI. Python 3.11+ on Linux/macOS is supported; signing uses
process locks and requires a dedicated wallet/state directory per instance.

Review [buyer configuration](../../examples/tasks/buyer.toml) and
[seller configuration](../../examples/tasks/seller.toml). Replace the contract and
role addresses. Keys and access tokens are private files with mode 600; state folders
must have mode 700. The two access-token files contain the same high-entropy token.
Every authorized buyer has its own token and wallet address. Buyer credentials never
grant seller signing rights. Seller runtime credentials stay in the existing backend.

Use separate wallet and seller processes. Task mode uses `mode = "task"` in its own
config and `envarpay task ...` commands. It deliberately does not overload the old
service setup `--mode` flag. Signing defaults off. Enable `signing_enabled` only for
approved test wallets; enable `evaluator_enabled` separately when delegating accept
and reject authority. Giving an agent the task wallet gives it those configured rights;
keep evaluator authority off when a human will decide in a separate controlled process.

## Fixed terms and task lifecycle

The buyer policy fixes provider, endpoint, tool and price. Each task freezes arguments,
acceptance text, token, contract, roles, amount and deadline into a canonical JSON
commitment. Reusing a request ID with changed terms is rejected. The initial version
uses the buyer as evaluator; providers explicitly authorize each buyer, acknowledging
that this is a trusted evaluator, not neutral arbitration.

```sh
envarpay task serve --config seller.toml
envarpay task create --config buyer.toml --peer seller --tool ask_agent \
  --request-id report-001 --arguments '{"question":"Summarize these records"}' \
  --acceptance 'Return JSON with all agreed totals and source IDs' --duration 3600
envarpay task status --config buyer.toml --request-id report-001
envarpay task result --config buyer.toml --request-id report-001
# Inspect the verified original result before deciding:
envarpay task accept --config buyer.toml --request-id report-001 --reason 'All checks passed'
```

`POST /tasks` receives frozen terms after escrow funding, returns 202 and the stable
job ID, and executes in a bounded background worker. `GET /tasks/{id}` only returns
the authenticated buyer's task. Current worker concurrency is one; queue capacity,
request size and response size are bounded. Connect an existing MCP or HTTP Agent
through EnvarPay's existing `Backend`; task settlement itself uses HTTP and does not
require a paid MCP call. No new agent runtime is created by EnvarPay.

Python code uses `TaskWallet(load_task_config(path))` and its `purchase`, `status`,
`result`, `recover`, `decide` methods. `envarpay task wallet --config buyer.toml`
exposes the same operations as stdio MCP tools. MCP callers cannot edit wallet policy.

## Refunds and failures

```sh
envarpay task reject --config buyer.toml --request-id report-001 --reason 'Acceptance failed'
envarpay task refund --config buyer.toml --request-id report-001 --reason 'Deadline passed'
envarpay task recover --config buyer.toml --request-id report-001
```

Reject and expiry are final. An execution error does not itself refund funds. The
buyer can reject a funded/submitted task, or trigger a refund after its deadline.
An early refund request is refused before freezing a decision. Only a verified full
refund releases the local task budget. Completed spends continue counting against
its cumulative limit. This is a dedicated task budget; it is not shared with an
existing call wallet, so use distinct funded keys for the two configurations.

The signer saves the original signed transaction before broadcast. Recovery queries
that hash and replays identical bytes only if the node does not know the transaction.
It never substitutes a nonce, amount or transaction. A decision that never produced
signed bytes can be explicitly changed; a signed decision stays frozen. An unresolved earlier transaction
blocks new signing. A reverted transaction is retained for manual diagnosis; this
version does not automatically replace or skip it.

A queued task rechecks live escrow before execution. A restarted task that was running
becomes `unknown`, never blindly reruns. A persisted result can retry its original
on-chain submission without executing the agent again. Clients can retrieve an original
submitted result after reconnecting. The chain status, execution status and verified
funding/payout/refund proofs are separate observations.

The embedded contract's runtime bytecode and immutable token are verified before
interactions. The buyer verifies exact token Transfer events for funding and payout/
refund, canonical block and confirmation depth. Provider submissions bind a result
commitment; retrieving the result checks that commitment. This establishes identity
of the submitted bytes, not their quality. The evaluator must use task-specific checks.

## Validation and limits

`tests/tasks` covers configuration, canonical terms, concurrent budgets, frozen
decisions, actual local EVM/HTTP lifecycle, receipt-loss recovery, unauthorized reads,
result tampering, expiry, refunds, service restart and a real SIGKILL during a worker
call. The killed backend is a deterministic test service, not a real model invocation.

Run the full existing suite and local EVM suite using the `Task escrow` workflow.
Contract builds are pinned and checked for artifact reproducibility. Local tests use
MockUSDC and chain 31337. Public tests require chain 84532 and Circle's official USDC.

Public acceptance remains separately required: current wheel + two native agents,
actual lock/submit/release, rejected and expired refunds, bounded signing recovery,
and an independent second-RPC receipt audit. Older x402 payments and the previous
standalone four-framework local POC are not evidence for this implementation.

## Candidate native acceptance

On 2026-10-01, the built candidate wheel completed two **local EVM** agent-driven
flows: Hermes → Hermes and Pydantic AI 2.52.0 → Hermes. Buyers actually called
`create_task`, fetched/verified the original result, and called `decide_task` through
the native MCP tool loop; the seller invoked native Hermes 2026.9.24 from source
`fc042f1d67bc393bf43920e92d4eb5082eddedfb`. Both used gpt-4.1-mini.
The result/transactions and wheel digest are in [evidence](evidence/native-final-local-summary.json).
This is stronger than harness-only orchestration, but still not public testnet evidence.

The unsigned-decision recovery fix is included in the final wheel recorded above.
Both native paths were repeated successfully using that exact wheel.

## Testnet deployment and audit tools

`examples/tasks/deploy.py` checks Base Sepolia and displays the deployer balance by
default. `--execute` explicitly authorizes a bounded deployment, preserving the
original signed deployment transaction in a private state directory. It does not
obtain test ETH, touch mainnet or reuse a different deployment automatically.

After a completed/refunded task, save `envarpay task status` JSON and run
`examples/tasks/audit.py --evidence STATUS.json --rpc INDEPENDENT_RPC` to independently
verify roles, committed terms and exact official-USDC transfer logs. Use a different
RPC from the transaction sender. Public-chain acceptance requires both this audit
and native runtime evidence for the same job and candidate build.
