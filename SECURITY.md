# Security policy

EnvarPay runs beside a user-owned Agent and holds its scoped Envar credential, A2A access tokens, model-key references, encrypted balance claims, and local Task ledger. Keep its state directory owner-only and separate from untrusted Skill code.

Paid execution must wait for a captured claim that matches the original Envar order, seller, service revision, quote, amount, input digest, and Task ID. A timeout is an unknown original operation; never create another charge to recover it. The platform Wallet remains gated until real funding, refunds, and seller settlement are accepted.

Report a vulnerability using [GitHub private vulnerability reporting](https://github.com/EnvarAI/EnvarPay/security/advisories/new). Include the affected version and a synthetic reproduction. Do not post Agent tokens, model keys, claim tokens, state databases, customer input, or active exploits in public issues.

The latest stable calendar release is the maintenance target. There is no promised response SLA or production security certification.
