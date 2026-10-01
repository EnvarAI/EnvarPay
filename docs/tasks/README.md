# Experimental task escrow

Task mode adds a fixed-price asynchronous job to EnvarPay: the buyer locks funds,
the provider executes and commits its deliverable, and the buyer explicitly accepts
or rejects it. Acceptance releases escrow; rejection or expiry refunds the buyer.
Existing `call`, x402 wire formats and `init --mode private/seller` keep their meaning.

This optional mode remains experimental. [Base Sepolia acceptance](testnet-acceptance.md)
passed five real escrow cases, including native-agent delivery and refunds. The bundled immutable contract is
experimental, not audited or a claim of full ERC-8183 compatibility. Mainnet is rejected.

## Installation and roles

Install the published Python distribution with its task extra:

```sh
python -m pip install --pre 'envarpay[task]'
```

Web3 is an optional dependency. Python 3.11+ on Linux/macOS is supported; signing uses
process locks and requires a dedicated wallet/state directory per instance.

Review [buyer configuration](../../examples/tasks/buyer.toml) and
[seller configuration](../../examples/tasks/seller.toml). Replace the contract and
role addresses. Keys and access tokens are private files with mode 600; state folders
must have mode 700. The two access-token files contain the same high-entropy token.
Every authorized buyer has its own token and wallet address. Buyer credentials never
grant seller signing rights. Seller runtime credentials stay in the existing backend.

JS/TS, Rust and other hosts can connect the task wallet's standard stdio MCP tools
without embedding a Python library. The npm `WalletClient` provides the separate
upfront-payment wallet API; it does not provide an in-process task signer.

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

Public acceptance is recorded separately in [testnet acceptance](testnet-acceptance.md):
actual lock/submit/release, rejected and expired refunds, original-transaction recovery,
and independent second-RPC receipt audits. Older x402 payments and the previous
standalone four-framework local POC are not used as evidence for this candidate.

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

## Website and remote MCP wallet

EnvarPay 0.1.0a8 adds `envarpay task wallet-serve --config task-buyer.toml`.
Configure `[wallet_server]` with a strong owner-only `bearer_token_file`, host, port
and allowed hosts. Register it in Envar as a **private task wallet**, apply its
ownership proof with `envarpay connect --config task-buyer.toml --task ...`, then
verify. The wallet never appears in public discovery.

The website Tasks page reads `task_policy`, sends `create_reviewed_task`, fetches
`task_result` and explicitly calls `decide_task`; recovery preserves the original ID.
Reviewed contract/token/provider/amount must still match the local policy.
Accept/reject authority defaults off. Normal task MCP tools and CLI commands remain
available. Configure distinct keys/state for concurrently operated wallets.

Task sellers expose a public read-only `/mcp` with `task_terms` and an ownership
proof when `[registration]` is configured. Register that entry as a task capability.
Set the buyer peer's optional `agent_id` and `endpoint_id` to connect public discovery
to that already-approved peer. Private task credentials and provider approval remain
operator responsibilities. The browser does not obtain signing keys or automatically
authorize a new provider. Task receipts in wallet responses are not platform-verified
Transactions rows. This remains an experimental Base Sepolia feature.

For explicit local task-provider approval, use `approve-peer --task --config
task-buyer.toml --name PROVIDER_ALIAS --url https://provider.example --pay-to
PROVIDER_ADDRESS --tool ask_agent --amount 0.01 --token-file ./seller-access.token
--agent-id PROVIDER_AGENT_UUID --endpoint-id TASK_ENDPOINT_UUID`. The website
provides a quoted command on a published task profile. This preserves signing,
evaluator authority and budgets, and refuses replacing different alias terms.
The reviewed creation path also checks the provider's current read-only `/terms`
before funding.
