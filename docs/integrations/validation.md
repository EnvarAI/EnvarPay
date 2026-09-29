# Validation ledger

This is a source-preview ledger, not a statement that all integrations work.
Updated 2026-09-29 for the unreleased 0.1.0a2 source. **New Docker cross-framework
paid acceptance: 0/30.** Every runtime must buy from and sell to the other five.
Only native Docker runs from pinned official sources count toward this matrix.
The older local probes below are diagnostic history, not matrix acceptance.

## Latest-source Docker run

[Official source commits](../../examples/cross-framework/sources.json) and
[experimental build/harness recipes](../../examples/cross-framework/README.md)
are recorded separately. Source downloads completed for Hermes, OpenCode, Goose,
LangGraph, LangChain and Pydantic AI. OpenClaw's source archive download and a
sparse checkout encountered slow transfers/disconnections; its image is pending.

- EnvarPay: renamed wheel built. Container version smoke passed using the previous
  verified dependency layer; this is not a clean dependency-install test.
- Python framework source build: corrected monorepo path resolution; dependency
  download subsequently failed/timed out against public package indexes.
- Hermes source build: Python 3.14 toolchain download has not completed.
- Goose source build: official Rust image layers have not finished downloading.
- OpenCode source build: npm and mirror connections reset while installing Bun.
- Dedicated test wallets/configs exist, with payments disabled and no funding
  transfers yet. No new signature, chain payment or native-model delivery is claimed.

The standard Base Sepolia RPC and public facilitator's supported-schemes endpoint
were reachable in a read-only check. That does not establish successful settlement.

## Earlier local diagnostics

| Runtime | Observed version | Actual check | Result | New payment |
|---|---|---|---|---|
| OpenCode | 1.15.13 | Native `opencode --pure mcp list` with isolated config and wallet subprocess | Connected | No |
| Hermes | 0.15.2 locally | Native `discover_mcp_tools()` in isolated HERMES_HOME | No tools: optional `mcp` package absent | No |
| Hermes | 0.20.0 official image, earlier run | Wallet registration and embedded model execution | Previously checked, not rerun here | No |
| OpenClaw | 2026.4.2 locally | CLI inventory using Node 22.22.0 | Has list/set/serve; lacks newer doctor/probe commands | No |
| Goose | Not installed locally | Executable prerequisite check | Needs isolated installation | No |
| LangChain / LangGraph | Not installed in inspected test environments | Dependency prerequisite / official documentation | Needs isolated installation and runtime test | No |
| Pydantic AI | Not installed in inspected test environments | Dependency prerequisite / official documentation | Needs isolated installation and runtime test | No |

The Homebrew default Node executable also failed to start due to a missing
`libllhttp.9.3.dylib`. Existing Node 22 was sufficient for inspecting the old
OpenClaw CLI; it does not satisfy the researched OpenClaw 2026.9.6 requirement.
Do not upgrade a user's global runtime as an implicit integration step.

After restoring normal tool permissions, the complete EnvarPay suite passed:
**76 tests**, including both real local TCP transports and the added HTTP/config
contracts. Ruff lint/format and wheel build passed. Facilitator/chain responses in
the suite are simulated. None are additional agent deliveries or chain transactions.

## What must pass before claiming support

1. The pinned host starts an isolated wallet process and discovers all three tools.
2. Its tool dispatch calls `payment_status` and sees a disabled-wallet refusal.
3. A real model selects and calls the wallet tool through that host's agent loop.
4. A dedicated seller receives no execution request before an exact confirmed receipt.
5. A Base Sepolia transaction matches the official USDC contract, payer, payee,
   amount and original authorization nonce; execution starts afterward and returns a result.
6. A repeat request returns the saved result; an unresolved request does not sign again.

Test OpenClaw -> Hermes and Hermes -> OpenClaw separately. Test OpenCode/Goose
buyers and LangChain/Pydantic MCP interoperability in their own environments.
Tool discovery is not model execution. Model execution is not paid delivery.

No funded wallet was used and no model credential was used for these checks.
The earlier [two-Hermes POC](../proof-of-concept.md) remains the only real-payment
evidence; it must not be attributed to this new candidate or these other hosts.
