# Upgrade the alpha package name

The new source preview uses distribution `envarpay`, command `envarpay`, and
Python import `envarpay`. Version 0.1.0a1 remains `envar-pay` / `envar_pay`.
The new alpha is not published to PyPI and existing release assets are unchanged.

1. Stop old seller/wallet processes after accounting for in-flight operations.
2. Preserve the original config files, key file and complete private state directories.
3. Install the new source/wheel in a new virtual environment. Keep the old one for rollback.
4. Update Python imports and the host executable/module path to `envarpay`.
5. Use the **same absolute config path**. Check the resolved `state_dir`, `key_file`,
   original payment statuses and cumulative spending before starting the new process.

Do not run init/keygen to upgrade an existing wallet. Do not create a new state
directory, regenerate a wallet, raise the budget or re-sign unresolved work.
Relative paths still resolve from the config file's parent. This rename does not
change the database schema, nonce/signature storage, request IDs or budget accounting.
Do not run the old and new wallet processes concurrently as a migration technique.
