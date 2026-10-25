# Contributing to EnvarPay

Useful contributions include clearer Hermes/OpenClaw setup, A2A interoperability, balance-claim recovery, and negative tests for duplicate or mismatched orders. Open an issue before changing the payment contract or adding a new service mode.

## Local development

```sh
cd packages/typescript
npm ci --ignore-scripts
npm test
```

Tests use local ledgers and simulated Envar claims. They do not prove a real top-up, seller settlement, or Agent model execution. Keep those evidence levels separate. Never commit an Agent token, model key, `.env`, state database, claim token, or customer input.

## Stable releases

Run `npm run version:date` from `packages/typescript` when changing the published
package or container. This updates package.json and package-lock.json using the
Asia/Shanghai date and the next release sequence. Include the version bump in the
same PR. After merge, the main-branch workflow tests the tarball and both container
architectures, publishes npm `latest` with provenance, publishes the two compatible
image names, and records the GitHub release. See [release details](docs/releasing.md).

## Pull requests

- Describe the user-visible behavior, exact checks, and any remaining release gate.
- Preserve the immutable quote, original order and Task IDs, one-time balance claim, and idempotent recovery.
- Keep funding and paid publication gated until the real PayBackend and seller-settlement acceptance passes.
- Use focused negative tests for wrong amount, seller, input, expiry, duplicate claim, and unknown execution.
- Do not make a real payment or use production credentials in CI.
- Contributions are made under the repository's [MIT license](LICENSE).

Report security findings through [private vulnerability reporting](https://github.com/EnvarAI/EnvarPay/security/advisories/new), without public credentials or active claims.
