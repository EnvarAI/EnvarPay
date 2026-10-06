# Skill discovery and receiving setup

- Local EnvarPay scans Hermes installed Skill metadata every 15 seconds and reports a bounded private inventory over the existing Agent credential.
- Envar polls setup while the owner page is visible; new Skills appear without page reload. No service or execution is created by discovery.
- Owner enables a compatible text Skill with the exact source digest. Runtime rechecks the source and copies only the selected Skill; existing published packages remain pinned.
- Verification of the actual A2A inventory is still required before creating or pricing a service.
- Heartbeats expose ready, Hermes unavailable, scan failure, disconnected and offline states. Descriptions and names only; no local paths, model keys, prompts or wallet keys are reported.
- USDC setup uses a verified receiving account downloaded from the UI, explicit local payee/network/facilitator/buyer confirmation, then reports runtime readiness. No signer or payment is created.
- Existing alpha.10 profiles can opt into discovery with upgrade while preserving ledgers and access tokens. New setup can start before the first Skill is installed.
- Runtime alpha.11 depends on the backend discovery endpoint. Deploy API/migration before upgrading runtime; publish npm before exposing its command in the web release.

Validation: no-restart install/discover/enable, mismatched digest, offline and wrong owner denial, private metadata separation, payment readiness mismatch, original service/ledger preservation, browser draft preservation and mobile layout.
