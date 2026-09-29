# Changelog

## 0.1.0a2 — unreleased candidate

- Unify distribution, CLI and Python import as envarpay; preserve original config and ledger paths.
- Add host-config snippets for OpenClaw, Hermes and OpenCode without editing personal configs.
- Add an experimental bounded HTTP runtime connector for dedicated existing agent services.
- Record actual per-version probes separately from model execution and paid chain delivery.
- Package tests pass (76); clean-container installation and live cross-framework acceptance remain pending. No PyPI release.


## 0.1.0a1

Initial public alpha of EnvarPay, extracted from the earlier two-Hermes payment POC.

- Python SDK and CLI for seller payment gates and bounded buyer wallets.
- Existing MCP backends and optional official Hermes integration.
- MCP Streamable HTTP, SSE and stdio; official x402 v2 exact USDC / EIP-3009.
- Upfront settlement plus exact Transfer and nonce verification before execution.
- Persistent local budget reservations, original-authorization storage, duplicate
  request protection and read-only reconciliation.
- Setup/configuration helpers, English/Chinese guides and MIT licensing.

Defaults: Base Sepolia, payment disabled, 10000 atomic test-USDC per call and total.
No automatic refunds, multi-host recovery, external signer provider, A2A task
support or new mainnet verification is claimed. See [POC evidence](docs/proof-of-concept.md)
for the distinction between the prior real payment and package/CI tests.
