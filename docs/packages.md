# Envar package channels

| Package | Runtime and current role |
| --- | --- |
| npm @envarai/envarpay | TypeScript A2A seller runtime: free services and Envar balance-claim verification |
| npm @envarai/connect | Native Agent connection, tasks and original-result recovery |
| PyPI envarpay | Legacy Python MCP/x402 wallet and seller code; separate configuration and API |

Start with the [local free service](local-free-service.md), or
[connect an existing Agent](https://envar.ai/guide/agents).
Both npm tools require Node.js 22.14 or newer; Node 24 is recommended.
Managed GHCR access is separate from public repository visibility.

For existing Python deployments, read [migration and support](legacy/python.md)
and the [fixed historical package guide](https://github.com/EnvarAI/EnvarPay/blob/c44bf8a1a04698241c47b17bcb2e675e8331fa89/docs/packages.md).
Do not mix legacy Python wallet state with current TypeScript seller state.


## Tested release combination

This checkout releases `@envarai/envarpay@2026.1108.1` with exactly
`@envarai/connect@2026.1107.2` bundled as its compatibility dependency.
Both use Agent Work v1; the package calendar versions are release dates, not
protocol versions. CI runs Node 22.14.0, current Node 22 and Node 24, including
an offline install of the packed artifact and the local free-service example.

The deployed Envar website selects its own reviewed Connect package and SHA-512
integrity. Its generated install command is authoritative for that deployment;
upgrading npm latest does not upgrade the website or an already running receiver.
See [Connect compatibility](https://github.com/EnvarAI/EnvarConnect/blob/main/docs/compatibility.md)
for journal preservation, native-runtime limitations and custom origins.

Legacy Python `envarpay` 0.1.0a11 and its 0.1.0a12 documentation-maintenance
release remain a separate API. They are not a Python implementation of this
TypeScript seller API and their wallet state cannot be migrated by changing a
package name. The maintenance artifact is published separately after its
original payload, dependencies and entry points have been compared.
