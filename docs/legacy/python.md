# Python EnvarPay is a legacy release line

The active EnvarPay seller runtime is TypeScript on Node.js. The Python package
named envarpay on PyPI is the earlier MCP/x402 wallet and payment gate. They share
a name, but they have different APIs, configuration files and payment semantics.

## Choose a path

| What you need | Supported entry |
| --- | --- |
| Try a current free A2A service locally | [Local free-service example](../local-free-service.md) |
| Use current Envar account-balance service purchases | [TypeScript seller runtime](../../packages/typescript/README.md) and [balance contract](../envar-balance.md) |
| Connect an existing Hermes/OpenClaw Agent to Envar | [EnvarConnect](https://github.com/EnvarAI/EnvarConnect) |
| Maintain an existing Python wallet or MCP payment gate | Its original environment and [fixed Python documentation](https://github.com/EnvarAI/EnvarPay/tree/c44bf8a1a04698241c47b17bcb2e675e8331fa89/docs) |
| Run a self-hosted copy of the complete Envar website/account ledger | Not included in the currently published Connect/Pay packages |

Do not replace an existing Python signer or payment service with the npm package
as an in-place upgrade. Do not copy its wallet config into a TypeScript seller
config. Preserve keys, state databases, original request IDs and unresolved
operations; read the original operation before deciding whether new work is safe.

Both packages expose an executable named envarpay. Use the full path to the
legacy virtualenv executable or the current project's node_modules/.bin/envarpay
so PATH selection does not silently choose another implementation.

## Fixed historical guides

The original Python 0.1.0a11 release is associated with commit
c44bf8a1a04698241c47b17bcb2e675e8331fa89. These guides describe that version:

- [Quickstart](https://github.com/EnvarAI/EnvarPay/blob/c44bf8a1a04698241c47b17bcb2e675e8331fa89/docs/getting-started.md)
- [Python API](https://github.com/EnvarAI/EnvarPay/blob/c44bf8a1a04698241c47b17bcb2e675e8331fa89/docs/python-sdk.md)
- [Historical Envar integration](https://github.com/EnvarAI/EnvarPay/blob/c44bf8a1a04698241c47b17bcb2e675e8331fa89/docs/envar.md)
- [Framework guides](https://github.com/EnvarAI/EnvarPay/blob/c44bf8a1a04698241c47b17bcb2e675e8331fa89/docs/integrations/index.md)
- [Upgrade and recovery](https://github.com/EnvarAI/EnvarPay/blob/c44bf8a1a04698241c47b17bcb2e675e8331fa89/docs/migration-envarpay.md)
- [Original package channels](https://github.com/EnvarAI/EnvarPay/blob/c44bf8a1a04698241c47b17bcb2e675e8331fa89/docs/packages.md)

Historical instructions are not current hosted-platform availability or
mainnet-payment acceptance evidence. The current platform's account-balance
claim API is different from the legacy Python payment flows.

## Documentation-maintenance distribution

The recipe in this repository prepares **0.1.0a12** from the immutable PyPI
0.1.0a11 artifacts. It changes the version, summary, readme and documentation
links. It preserves every installed Python/package file, runtime requirement,
optional dependency, entry point and MIT notice. The CLI reports the new
installed distribution version through its existing metadata lookup.

This is not a new Python feature release, a Node installer, or a migration of
wallets or funds. The original 0.1.0a11 files remain available. Registry
publication is a separate manual release step; check the
[PyPI version list](https://pypi.org/project/envarpay/#history) before selecting
a version.

We keep the historical source/docs readable and accept actionable packaging,
migration and security reports. New seller and connector development belongs
to the TypeScript packages. This does not promise fixes or continuing runtime
compatibility for every historical dependency, network or Agent version.

[Maintenance recipe and publishing](python-maintenance.md)
