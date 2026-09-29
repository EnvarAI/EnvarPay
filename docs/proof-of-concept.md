# A real testnet payment, with explicit evidence boundaries

This page preserves the earlier two-Hermes POC. The later source-preview
[six-framework Docker matrix](integrations/validation.md) records 28 additional
paid deliveries and two failed settlements, with separate transaction evidence.

On 2026-09-29, an earlier local POC ran two real Hermes agents in separate Docker
containers. Agent B received x402 v2 PaymentRequired over MCP, paid Agent A **0.01
test USDC on Base Sepolia**, and received a model-generated Chinese answer about
running a small team's weekly knowledge review. Agent A started the task only
after its exact Transfer check passed.

| Fact | Evidence |
|---|---|
| Network | Base Sepolia, `eip155:84532` |
| USDC contract | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| Buyer | `0xaE28e53648131ffCb945574cB55c1D4f88681Ea7` |
| Seller | `0xaCf233534e258177f6dc704e6251294D96638ACC` |
| Amount | 10000 atomic = 0.01 test USDC |
| Buyer balance | 20 → 19.99 test USDC |
| Seller balance | 0 → 0.01 test USDC |
| Block | 47449637 |
| Transaction | [0xade8b0…ea213](https://sepolia.basescan.org/tx/0xade8b0b108ae664162e2c01530ed03a01ac4f25a52e0036140f28bcccd7ea213) |

The public receipt contains the exact B→A USDC Transfer and the original nonce's
AuthorizationUsed event. See [receipt fixture](../tests/fixtures/real-sepolia-receipt.json)
and [sanitized POC output](evidence/poc.json). No private keys or signed payment
payloads are included. The off-chain timeline is a local execution record, not
an independently signed attestation of model quality or service availability.

The ordering recorded locally was:

```text
payment_required → payment_signed → settlement_reported → transfer_confirmed
→ agent_a_started → agent_a_completed → agent_a_result_received → agent_b_completed
```

## What this proves—and what it does not

The POC proves one real **testnet** payment and one actual agent delivery using the
MCP/x402 path. Test USDC has no monetary value. It does not prove production
reliability, mainnet readiness, refunds, task quality or arbitrary-runtime interoperability.

The SDK was extracted afterward. Its validation includes clean wheel installation,
native wallet-tool registration in official Hermes 0.20.0, actual model connectivity,
real local HTTP/SSE/stdio tests and a fresh read-only check of the existing receipt.
The tests' simulated facilitator responses, offline signatures and CI results
are **not additional payments**. Later payments through the 0.1.0a2 source-preview
wheel are recorded in the matrix linked above; the 0.1.0a1 release remains unchanged.
