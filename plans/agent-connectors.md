# Native Envar Connector (P3, ready for package CI)

Depends on EnvarAI's WorkService (#120) and guided cloud connector (#121). The full objective still includes all six real Dots/Hermes/OpenClaw directions and Envar balance commerce, not only this package's unit tests.

## Boundaries

- `connector/contracts.generated.ts`: generated from the copied canonical Envar Work JSON Schema, with an exact source digest. EnvarAI owns the schema; regenerate this consumer after intentional contract changes.
- `connector/client.ts`: outbound HTTPS and scoped Envar credential only; no implicit POST retry, cross-origin redirects, account management or wallet authority.
- `connector/state.ts` and `loop.ts`: private SQLite journal, stable claim/event IDs, preparation/admission/dispatch/result phases. Persist before mutation; resume original executions and pending reports before accepting new work. A started execution never transfers or restarts on a missing heartbeat.
- `adapters/types.ts`: one RuntimeAdapter interface with explicit capability evidence and opaque versioned native references. Adapter references contain no credentials.
- `adapters/hermes.ts`, `openclaw.ts`, shared native A2A transport: use the existing native runtime and session/tool environment. Instruction-only skill runners are a separate service binding, not a substitute for a general Agent.
- Native model credentials stay with the runtime. Envar's receiving credential stays in a private local file. Pairing needs owner approval of one Agent and does not inherit account authority.

## Current runtime evidence

The existing isolated OpenClaw 2026.10.4 exposes normal Gateway-backed `openclaw agent`, explicit session ID/key, `--message-file` and JSON output. `gateway call` supports immediate versus final responses. Installed source also contains native MCP bundle configuration; inspect that schema before installing the connector tools. Do not assume MCP is unsupported or use only a prompt skill without checking.

The existing Hermes image installs its CLI at `/opt/hermes/bin/hermes`; it supports sessions/resume and a gateway. Its private A2A endpoint has previous real execution evidence, but the new adapter must verify original Task/session recovery.

Fresh containers now verify authenticated native A2A and native discovery of all eight Envar MCP tools for OpenClaw 2026.10.4 and Hermes CLI 2026.9.24. The official Hermes image drops root to UID 10000, so setup must run as its `hermes` user with `HOME=/opt/data`. No new model execution or commerce is claimed from these non-inference probes.

## Implementation and remaining acceptance

1. Reuse the existing Envar setup-ticket lifecycle for browser-approved pairing (EnvarAI companion changes), with a device poll secret and short code; never place a long-lived credential in the URL or shell command.
2. Native probe, exact Agent/session binding, outgoing MCP tools, durable receiving loop and original-reference recovery.
3. Per-runtime setup/doctor/status/disconnect and service lifecycle instructions. No public tunnel for normal inbox receiving.
4. Fault tests for lost start response, stale claim, restart with/without a native handle, result retry and result acknowledgement. Then fresh-container/browser acceptance through the public guide.
5. P4 integrates the same admission path with explicit owner spending grants and the original balance order. PayBackend remains unchanged.

## Package delivery

Version `2026.1027.1` bundles its tested runtime dependencies. The tarball verifier installs offline with an empty cache, exercises both CLI families and imports public exports. Envar's companion build pins the published SHA512 and serves the exact archive from `/downloads/`; a local package checksum is not publication evidence. CI/merge/npm release must finish before the companion frontend is merged.

Current local suite: 129 passing tests, including known pre-start failure, lost admission response, unknown native dispatch, restart recovery, cached terminal observations, pending report replay, original outgoing IDs and explicit fresh pairing while preserving journals. Six real Agent directions and paid orders remain pending.
