# EnvarPay

Add a budgeted payment wallet and an upfront USDC payment gate to existing agents.
EnvarPay uses the official MCP and x402 v2 SDKs. Your agent keeps its own runtime,
model and tools.

## Install

These registry commands apply after publication. For the current source preview,
see [installation channels](https://github.com/EnvarAI/EnvarPay/blob/main/docs/packages.md).

For a persistent CLI installation:

```sh
uv tool install envarpay==0.1.0a6
envarpay --help
```

For the Python API, use an isolated environment:

```sh
python -m pip install envarpay==0.1.0a6
```

Python 3.11 or newer is required. Keep the wallet environment separate from
frameworks using a different MCP major version.

## Choose a capability

- **Pay:** `envarpay wallet` exposes policy-constrained MCP tools to your agent.
- **Receive:** `envarpay serve` puts a payment gate in front of a private MCP or HTTP service.
- **Set up:** `envarpay init --agent NAME --role buyer|seller|both` generates editable configs and instructions.
- **Inspect:** `envarpay doctor`, `status` and the explicit original-operation recovery flow.

Start with the guide for your framework:

- [OpenClaw](https://github.com/EnvarAI/EnvarPay/blob/main/docs/integrations/openclaw.md)
- [Hermes](https://github.com/EnvarAI/EnvarPay/blob/main/docs/integrations/hermes.md)
- [OpenCode](https://github.com/EnvarAI/EnvarPay/blob/main/docs/integrations/opencode.md)
- [Goose](https://github.com/EnvarAI/EnvarPay/blob/main/docs/integrations/goose.md)
- [LangGraph / LangChain](https://github.com/EnvarAI/EnvarPay/blob/main/docs/integrations/langgraph.md)
- [Pydantic AI](https://github.com/EnvarAI/EnvarPay/blob/main/docs/integrations/pydantic-ai.md)

MCP connections work across languages. An agent does not need to be written in
Python to connect to this service. This distribution includes a Python SDK and
CLI; it does not claim to include a TypeScript SDK or a framework-native plugin.

## Alpha boundaries

Payments default to **off**, using Base Sepolia test USDC and explicit recipient,
tool and budget policies. Preserve the original request ID, authorization and
ledger on uncertainty. A paid request can still fail during execution; payment
does not establish output quality or an automatic refund.

The historical [testnet matrix](https://github.com/EnvarAI/EnvarPay/blob/main/docs/integrations/validation.md)
records 28 successful paid deliveries and two failed settlements across six
native frameworks. Package installation and CI are not additional payment evidence.

[Repository](https://github.com/EnvarAI/EnvarPay) ·
[Configuration](https://github.com/EnvarAI/EnvarPay/blob/main/docs/configuration.md) ·
[Python API](https://github.com/EnvarAI/EnvarPay/blob/main/docs/python-sdk.md) ·
[Security](https://github.com/EnvarAI/EnvarPay/security/advisories/new)
