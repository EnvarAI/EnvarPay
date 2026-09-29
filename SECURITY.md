# Security policy

EnvarPay is alpha software. It is not a reviewed production custody service.
Use dedicated, narrowly funded wallets, private state directories and an isolated
signer process. Running a wallet under an agent's unrestricted shell identity
does not isolate its private key.

Report a vulnerability using [GitHub private vulnerability reporting](https://github.com/EnvarAI/EnvarPay/security/advisories/new).
Include the affected version, expected/actual behavior and a minimal reproduction
using synthetic data or a local test double. Do not post wallet keys, API tokens,
signed authorizations, customer data or active exploits in public issues.

The latest alpha on `main` is the current maintenance target. There is no promised
response SLA or production security certification. Changes affecting signing,
budget accounting, settlement, nonce handling or execution gates need focused
negative tests and clearly stated remaining limitations.
