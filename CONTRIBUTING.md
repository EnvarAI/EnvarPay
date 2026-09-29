# Contributing to EnvarPay

Useful first contributions include another MCP client integration, reproductions
of SDK compatibility issues, clearer onboarding and stronger failure-path tests.
Before a large change, open an issue describing the user need and protocol scope.

## Local development

```sh
python -m venv .venv
source .venv/bin/activate
python -m pip install -e '.[test]'
ruff check src tests examples
ruff format --check src tests examples
pytest -q
python -m build
```

Tests use real local MCP transports and simulated facilitator responses. They
do not transfer funds or call a model API. Keep that distinction explicit when
reporting results. Never add a private key, API token, `.env`, state database or
signed authorization to a PR or issue.

## Pull requests

- Keep the change focused; describe the observable behavior and validation.
- Preserve standard MCP and x402 wire formats. Avoid private settlement endpoints.
- Keep payment disabled in examples, use testnet defaults, and retain budgets on
  uncertain outcomes. Do not silently replace a signed authorization on retry.
- Test monetary behavior and failures, including duplicate/concurrent requests.
- Do not make a mainnet payment, publish a package, or use production credentials
  as part of a test run.
- Contributions are made under the repository's [MIT license](LICENSE).

Security findings belong in the [private vulnerability reporting channel](https://github.com/EnvarAI/EnvarPay/security/advisories/new),
not in a public issue with live credentials or an exploitable authorization.
