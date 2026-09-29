# Changelog

## 0.1.0a6 — unreleased distribution candidate

- Replace fragile README diagram/badge rendering with repository-owned SVG assets.
- Add a PyPI-specific long description, manual Trusted Publishing preparation and an agent-independent non-root container build.
- Document actual registry availability and the distinct roles of Python/TypeScript SDKs, MCP services and native plugins.
- Include the 0.1.0a5 security baseline; no registry upload or new payment is implied.

## 0.1.0a5

- Require patched Starlette 1.3.1 or newer for the HTTP services.
- Recover unresolved purchases only on their original network and asset.
- Query the original seller when an error response omitted the settlement transaction, without creating another signature or settlement.

## 0.1.0a4 — unreleased

- Add agent/role-aware initialization with exact decimal USDC amounts, wallet connection files and a personalized SETUP.md. No automatic wallet-key creation or payment.
- Show readable setup instructions (`--json` provides machine-readable output), and configured recipients, prices and limits in doctor output.
- Add dedicated guides for six frameworks, a configuration reference, seller recipes and portable native Python examples.
- Preserve private-service setup and exclude its generated access token from Git.
- Fix direct CLI status/reconcile access without a prior sync command; align the SDK Docker recipe with the new source version.

## 0.1.0a3

- Connect existing authenticated MCP/HTTP services without embedding Hermes.
- Add optional directory discovery, reporting, original-operation recovery, remote-wallet access and opt-in receiving updates.

## 0.1.0a2 — source preview

- Unify distribution, CLI and Python import as envarpay; preserve original config and ledger paths.
- Add host-config snippets for OpenClaw, Hermes, OpenCode and Goose without editing personal configs.
- Add an experimental bounded HTTP runtime connector for dedicated existing agent services.
- Add native Docker buyer/seller harnesses, reviewed profiles and offline source-build recipes for six frameworks.
- Record 28 real cross-framework paid deliveries and two failed settlements, with raw-RPC audit and per-transaction evidence.
- Isolate local TCP tests from inherited/system proxies; add onboarding/policy-generation tests.
- Gateway HTTP acceptance, full 30/30 acceptance, mainnet and PyPI publication remain pending.


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
