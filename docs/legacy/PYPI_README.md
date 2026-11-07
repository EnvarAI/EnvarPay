# Legacy Python EnvarPay

**This PyPI project is the legacy Python MCP/x402 wallet and payment gate.**
The 0.1.0a12 release updates package documentation and links only. Its installed
Python package files, runtime dependencies and CLI entry point are unchanged
from 0.1.0a11. The installed distribution version is the expected exception.

New Envar development uses TypeScript:
- [EnvarPay on npm](https://www.npmjs.com/package/@envarai/envarpay) runs free A2A
  services and verifies Envar account-balance claims for paid services.
- [EnvarConnect](https://github.com/EnvarAI/EnvarConnect) connects an existing
  Hermes/OpenClaw Agent through outbound HTTPS.
- [Current local free-service guide](https://github.com/EnvarAI/EnvarPay/blob/main/docs/local-free-service.md)
  demonstrates the current seller runtime without an Envar account or payment.

The TypeScript packages are not replacements for the Python import API or for
an existing Python wallet. Installing this Python package does not install npm,
create an Envar account, migrate funds, rewrite credentials or change ledgers.

## Existing Python installations

Preserve the original environment, configuration, keys, request IDs and state.
Use an explicitly pinned package in its own virtual environment. For example,
after reviewing the maintenance release:

~~~sh
/path/to/legacy-venv/bin/python -m pip install 'envarpay==0.1.0a12'
/path/to/legacy-venv/bin/envarpay --version
~~~

Both distributions use the command name envarpay. Keep the legacy virtualenv
entry point separate from the current npm executable. Do not copy a Python
wallet configuration into a TypeScript seller configuration.

The legacy Python implementation retains its historical MCP/x402 and
experimental task-escrow behavior. It does not become the current Envar
account-balance seller runtime. Its historical Envar integration documentation
does not establish that the current hosted platform still accepts those routes.
No new payment, mainnet, runtime or deployment acceptance is claimed by this
documentation maintenance release.

## Fixed documentation for the Python code

These links point to the exact source commit used by the original 0.1.0a11
release, rather than to the TypeScript main branch:

- [Python quickstart](https://github.com/EnvarAI/EnvarPay/blob/c44bf8a1a04698241c47b17bcb2e675e8331fa89/docs/getting-started.md)
- [Python SDK](https://github.com/EnvarAI/EnvarPay/blob/c44bf8a1a04698241c47b17bcb2e675e8331fa89/docs/python-sdk.md)
- [Historical Envar integration](https://github.com/EnvarAI/EnvarPay/blob/c44bf8a1a04698241c47b17bcb2e675e8331fa89/docs/envar.md)
- [Framework integrations](https://github.com/EnvarAI/EnvarPay/blob/c44bf8a1a04698241c47b17bcb2e675e8331fa89/docs/integrations/index.md)
- [Original-operation recovery and upgrade notes](https://github.com/EnvarAI/EnvarPay/blob/c44bf8a1a04698241c47b17bcb2e675e8331fa89/docs/migration-envarpay.md)
- [Historical package channels](https://github.com/EnvarAI/EnvarPay/blob/c44bf8a1a04698241c47b17bcb2e675e8331fa89/docs/packages.md)
- [Current migration and support boundary](https://github.com/EnvarAI/EnvarPay/blob/main/docs/legacy/python.md)

Legacy features receive no new feature-development commitment. Report a
reproducible packaging or migration problem in
[GitHub Issues](https://github.com/EnvarAI/EnvarPay/issues); report security issues
[privately](https://github.com/EnvarAI/EnvarPay/security/advisories/new), without
keys, payment authorizations, state databases or customer content.

## Maintenance provenance

The build recipe downloads the hash-pinned original sdist and wheel, updates
only package metadata/documentation, rebuilds with the Python build backend,
and checks every installed package file against the original wheel. It also
checks dependency metadata, Python requirements, entry points and the source
archive inventory. The original 0.1.0a11 artifacts remain unchanged.

This is still an alpha legacy distribution, not a new stable Python product.
The MIT license and original notices are retained.
