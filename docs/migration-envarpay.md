# Upgrade the alpha package name

The new source preview uses distribution `envarpay`, command `envarpay`, and
Python import `envarpay`. Version 0.1.0a1 remains `envar-pay` / `envar_pay`.
The `envarpay` alpha is now published on PyPI. Keep existing source/wheel installs
until you have validated the selected registry version with your existing config.

1. Stop old seller/wallet processes after accounting for in-flight operations.
2. Preserve the original config files, key file and complete private state directories.
3. Install the chosen pinned `envarpay` version from PyPI in a new virtual environment. Keep the old one for rollback.
4. Update Python imports and the host executable/module path to `envarpay`.
5. Use the **same absolute config path**. Check the resolved `state_dir`, `key_file`,
   original payment statuses and cumulative spending before starting the new process.

Do not run init/keygen to upgrade an existing wallet. Do not create a new state
directory, regenerate a wallet, raise the budget or re-sign unresolved work.
Relative paths still resolve from the config file's parent. This rename does not
change the database schema, nonce/signature storage, request IDs or budget accounting.
Do not run the old and new wallet processes concurrently as a migration technique.

## 0.1.0a4 new-setup CLI changes

`init` now accepts `--agent` and `--role buyer/seller/both`, writes a local `SETUP.md`,
and defaults to the generic MCP backend. The embedded `hermes` backend has been
removed on main; connect an existing `hermes-http` or MCP service instead. Existing
`--mode private` setup remains available without a wallet. `--price`, `--max-per-call` and `--budget` take
decimal USDC, while existing TOML policies continue to store atomic integers.

Initialization prints readable instructions by default; scripts consuming its
JSON output should add `--json`. `host-config` and `doctor` still emit JSON.
Existing configs and payment ledgers require no rewrite for these setup changes.
