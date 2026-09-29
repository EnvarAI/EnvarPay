# LangGraph / LangChain: pay and get paid

Use the framework's native MCP adapter to give your agent a payment wallet.
Expose one agent invocation as a private MCP tool to sell its work. The wallet
runs in a separate EnvarPay environment; the framework keeps its own dependencies.

The [official-source Docker matrix](validation.md) contains real purchases and
sales for this framework. New onboarding/configuration checks are not additional payments.

## 1. Create the wallet in EnvarPay's environment

Follow the [installation guide](../getting-started.md#install), then:

```sh
envarpay init --agent langgraph --role buyer --directory ./langgraph-pay \
  --peer-url https://seller.example/mcp --pay-to SELLER_FULL_ADDRESS \
  --max-per-call 0.01 --budget 0.05
envarpay keygen --output ./langgraph-pay/buyer.key
envarpay doctor --config ./langgraph-pay/buyer.toml
```

Keep payments off while testing the connection. The generated `wallet-command.json`
contains the **absolute EnvarPay interpreter** and config path. That is the process
the framework will launch; do not install EnvarPay into the framework's MCP 2 environment.

## 2. Prepare the framework environment

The portable example is [python_agents.py](../../examples/integrations/python_agents.py).
It uses the same native APIs as the Docker acceptance harness. Run it with a
separate framework venv or the recorded `envarpay:matrix-python` image.

For the exact source snapshot used in the matrix, create a separate venv and
install the official source packages together:

```sh
python3 -m venv .venv-langgraph
source .venv-langgraph/bin/activate
python -m pip install \
  "langchain-core @ git+https://github.com/langchain-ai/langchain.git@ce9066138d0e234109ac7dd60a10ad7cc10cdfda#subdirectory=libs/core" \
  "langchain[mcp] @ git+https://github.com/langchain-ai/langchain.git@ce9066138d0e234109ac7dd60a10ad7cc10cdfda#subdirectory=libs/langchain_v1" \
  "langchain-openai @ git+https://github.com/langchain-ai/langchain.git@ce9066138d0e234109ac7dd60a10ad7cc10cdfda#subdirectory=libs/partners/openai" \
  "langgraph @ git+https://github.com/langchain-ai/langgraph.git@07b33185eab893be2ed031eedae52f09314bf77c#subdirectory=libs/langgraph" \
  "langgraph-checkpoint @ git+https://github.com/langchain-ai/langgraph.git@07b33185eab893be2ed031eedae52f09314bf77c#subdirectory=libs/checkpoint" \
  "langgraph-prebuilt @ git+https://github.com/langchain-ai/langgraph.git@07b33185eab893be2ed031eedae52f09314bf77c#subdirectory=libs/prebuilt" \
  "langgraph-sdk @ git+https://github.com/langchain-ai/langgraph.git@07b33185eab893be2ed031eedae52f09314bf77c#subdirectory=libs/sdk-py" \
  "fastmcp>=4,<5"
```

These are frozen acceptance commits, not a claim to follow the latest branch on
every installation. The [source catalog](../../examples/cross-framework/sources.json)
and [Docker build recipes](../../examples/cross-framework/README.md) record the
reproducible inputs. If you already have a compatible framework environment, keep it.
Earlier releases may expose different MCP APIs; don't mix instructions across versions.

## 3. Check MCP without a model call or payment

Run from the EnvarPay checkout using the **framework** Python:

```sh
python examples/integrations/python_agents.py langgraph probe \
  --wallet-command /absolute/path/langgraph-pay/wallet-command.json
```

Expected: the four core wallet tools and an empty status for `setup-check-never-paid`.
Probe does not require a model credential, sign an authorization or invoke a paid tool.

The official FastMCP compatibility mode bridges the framework's MCP 2 environment
to EnvarPay's MCP 1.28.1 process:

```python
import json
from pathlib import Path
from fastmcp import Client
from fastmcp.client.transports import StdioTransport

command = json.loads(Path("/absolute/path/langgraph-pay/wallet-command.json").read_text())
wallet = Client(StdioTransport(**command), mode="legacy", timeout=750, init_timeout=30)

# `model` is your configured framework model; `task` is your agent instruction.
from langchain.agents import create_agent
from langchain.mcp import MCPAdapter

async with MCPAdapter(wallet) as adapter:
    agent = create_agent(model, await adapter.list_tools())
    result = await agent.ainvoke({"messages": [{"role": "user", "content": task}]})
```

## 4. Let the native agent purchase a capability

Fund the dedicated buyer address with Base Sepolia test USDC. Review the exact
seller, chain/asset, allowed tool and budgets, then set `payments_enabled = true`.
Configure `MODEL_NAME`, `MODEL_BASE_URL` and `MODEL_API_KEY` securely in the framework
process environment. The portable example does not choose a fallback model/provider.

```sh
python examples/integrations/python_agents.py langgraph buyer \
  --wallet-command /absolute/path/langgraph-pay/wallet-command.json \
  --request-id review-001 --question "Review these notes"
```

This **can spend within the enabled wallet policy**. The framework model makes the
tool call; the controller does not bypass the native loop. The example requests
exactly one `ask_agent` purchase and stops on uncertainty. Use the original request
ID for the same purchase and preserve the ledger on failure.

## 5. Sell a capability

With the same model environment variables available, start the private native
framework service in one terminal:

```sh
python examples/integrations/python_agents.py langgraph seller
```

It exposes `ask_agent` at `http://127.0.0.1:8000/mcp`. Keep it private. In another
terminal, activate the **EnvarPay** environment and create the gate:

```sh
envarpay init --agent langgraph --role seller --directory ./langgraph-seller \
  --pay-to YOUR_FULL_RECEIVING_ADDRESS \
  --upstream http://127.0.0.1:8000/mcp --tool ask_agent --price 0.01
envarpay serve --config ./langgraph-seller/seller.toml
```

Only expose the payment gate on port 4020 through your HTTPS service. The receiving
address is sufficient; the seller does not load its private key. The framework
operation starts only after the outer gate verifies the payment receipt.

The example calls the real LangChain `create_agent` loop backed by LangGraph.
For an existing graph, expose one bounded `graph.ainvoke(...)` operation instead.
A deployed LangGraph Agent Server can also expose `/mcp`, but a library installation
alone is not that deployed service; configure your real endpoint explicitly.

## Troubleshooting

| Symptom | Check |
|---|---|
| Import error for the native MCP adapter | Match the documented source/version; older releases use different MCP APIs |
| Dependency solver conflicts with MCP | Keep EnvarPay and the framework in separate environments |
| Negotiation starts with unsupported `server/discover` | Use the official `mode="legacy"` client in the example |
| Wallet subprocess is missing | Check absolute paths in `wallet-command.json`; regenerate the snippet if moving machines, preserving wallet/state paths |
| Model variables missing | Provide `MODEL_NAME`, `MODEL_BASE_URL`, `MODEL_API_KEY`; probe needs none of them |
| Payment or execution is uncertain | Keep original request ID/authorization/state; don't create another purchase to get past the error |

[All agents](index.md) · [Configuration](../configuration.md) · [Python SDK](../python-sdk.md)

Optional: [original-operation recovery, directory discovery and remote wallet isolation](../directory-and-recovery.md). Recovery can resume an already-paid task that never started; it does not create a fresh signature.
