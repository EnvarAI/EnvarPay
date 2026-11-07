# Contribution tasks

These are bounded areas for contributions, not claims that a listed bug currently exists. Start with a synthetic reproduction or a concrete improvement. Use the existing tests as the contract and discuss changes to pricing, payment semantics or service modes before implementation.

First run the [local free service](local-free-service.md). From `packages/typescript`, `npm ci --ignore-scripts` and `npm test` are the normal contributor checks. Package validation is part of that suite; no production account or real payment belongs in tests.

Code, test and example paths below are relative to `packages/typescript/`; `docs/`, `scripts/` and repository metadata paths are relative to the repository root.

## 1. Make an installation failure reproducible

- **Outcome:** a newcomer can identify the exact Node version, package version, runtime and command that failed.
- **Start:** run the local example from source and an installed tarball on a supported environment; redact private paths and tokens.
- **Files:** `examples/local-free-service/`, `test/local-free-service.test.mjs`, `docs/local-free-service.md`.
- **Acceptance:** the existing local replay proof still has one capability execution and no payment attempts; documentation describes observed behavior without claiming unsupported platforms.
- **Good first contribution:** improve a specific error or a misleading setup step with an accompanying synthetic reproduction.

## 2. Add a protocol compatibility fixture

- **Outcome:** a supported A2A peer's input encoding or Task response works without guessing or silently falling back.
- **Start:** capture a minimal, synthetic Card and response shape from the peer's official documentation; explain its version and expected binding.
- **Files:** `src/commerce/upstream.ts`, `test/commerce-http.test.mjs`, `test/commerce-wire.test.mjs`.
- **Acceptance:** use explicit data/json-text encoding; preserve the original message and Task; reject cross-origin credential forwarding and changed Task identity.
- **Boundary:** transport tests do not establish that the real model/runtime completed a task.

## 3. Add a negative balance-receipt case

- **Outcome:** a mismatched quote, amount, seller, service revision, input or original Task cannot open execution.
- **Start:** extend an existing synthetic receipt fixture with one changed field.
- **Files:** `src/commerce/envar-balance.ts`, `schemas/balance-claim.v1.schema.json`, `schemas/balance-receipt.v1.schema.json`, `test/commerce-envar-balance.test.mjs`.
- **Acceptance:** the original receipt replays, the changed receipt is rejected, and the private executor count does not increase.
- **Boundary:** do not change the payment contract to make a fixture pass; contract changes need coordinated platform review.

## 4. Exercise an interrupted original operation

- **Outcome:** a stored result or original remote Task can be recovered without creating a replacement order or repeating a possibly-started execution.
- **Start:** use the existing recovery test's local store, original Task handle and failure injection.
- **Files:** `src/commerce/store.ts`, `src/commerce/server.ts`, `test/commerce-recovery.test.mjs`, `docs/a2a-runtime-recovery.md`.
- **Acceptance:** Task/order identities and payment attempts remain unchanged across store restart; lack of evidence remains unknown.
- **Boundary:** a process reconnect is not proof of actual model completion or cancellation.

## 5. Improve an installed-Skill compatibility case

- **Outcome:** an operator can discover and explicitly enable a real installed Skill without exposing unrelated private capabilities.
- **Start:** supply an isolated profile fixture and the native runtime version/schema involved.
- **Files:** `src/commerce/native-inventory.ts`, `src/commerce/native-skills.ts`, `test/commerce-native-skills.test.mjs`, `test/commerce-skill-gate.test.mjs`.
- **Acceptance:** the selected Skill digest and scope remain bound to the service; absent or changed Skills fail clearly.
- **Boundary:** native task connectivity adapters are maintained in [EnvarConnect](https://github.com/EnvarAI/EnvarConnect), not a second implementation here.

## 6. Keep the public artifact usable

- **Outcome:** documented commands work from the installed package, not only from repository-relative imports.
- **Start:** reproduce a missing file, export or CLI helper using the packed-artifact tests and an empty npm cache.
- **Files:** `test/local-free-service.test.mjs`, `test/commerce-contracts.test.mjs`, `scripts/verify-package.mjs`, package export/file declarations.
- **Acceptance:** normal `npm test` and the existing publishing-artifact checks succeed; examples use public exports; no private state or retired files enter the package.
- **Boundary:** publishing, changing package contents and version bumps follow [releasing.md](releasing.md); a passing local test is not a registry publication.

## What to include in a contribution

Give the observed behavior, minimal reproduction, affected versions, changed files and exact checks. Link the existing issue if there is one. Separate local protocol/fixture evidence, real runtime execution and any money evidence. If a change requires private platform integration, say which public contract it affects so a maintainer can run that acceptance.

Use the [security policy](../SECURITY.md) for private vulnerability reporting. Do not attach private credentials, claims, ledgers or customer inputs to public reports.

## Maintenance expectations

For a reproducible report or a scoped contribution, maintainers aim to give an
initial response within two business days and a review or explicit next step
within five business days. This is a best-effort target, not a support SLA; an
owner should post a status update when a response takes longer.

Triage reports as reproducible bug, documentation, compatible enhancement,
needs reproduction, or outside current scope. Record the reproduction, owner
and next step in the existing issue rather than creating duplicate work.
Changes to payment behavior, pricing, service modes or private platform
integration need the corresponding owner review before implementation. An open
contribution brief is not approval to add a new payment rail.
