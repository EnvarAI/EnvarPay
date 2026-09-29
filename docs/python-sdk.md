# Python SDK

Install the package into your Python 3.11+ environment. Configuration, budgets and
state are shared with the CLI; using the Python API does not bypass them.

## Buy a capability

```python
import asyncio
from pathlib import Path

from envarpay import WalletService, load_config

async def main():
    wallet = WalletService(load_config(Path("buyer.toml")))
    tools = await wallet.list_tools("seller")
    print(tools)
    result = await wallet.call(
        peer_name="seller",
        tool="ask_agent",
        arguments={"question": "Review these notes"},
        request_id="review-001",
    )
    print(result)

asyncio.run(main())
```

Only enable payments after reviewing the configured wallet, network, recipients,
tools and limits. Preserve the same request ID for a retry of the same purchase.
`PaymentError` from `envarpay.storage` reports policy or uncertain-result refusals.
Successful results include the tool's content and independently checked payment
proof. A simulated test response is never a real settlement receipt.

## Expose a paid MCP server

```python
from pathlib import Path

import uvicorn
from envarpay import PaidServer, load_config

service = PaidServer(load_config(Path("seller.toml")))
uvicorn.run(service.app(), host=service.policy.host, port=service.policy.port)
```

The returned ASGI app handles `/mcp`, `/sse` and `/messages/`. Its lifespan checks
the RPC network, facilitator support and configured backend tools before serving.
Keep the ASGI lifespan enabled. The backend can be a configured MCP endpoint or
an installed official Hermes runtime, or the experimental existing-runtime HTTP connector. See the framework guides and validation ledger for actual support levels.

## Inspect state

```python
status = wallet.store.public_status("buy:review-001")
```

Public status omits stored signatures and task arguments. Full local state is
sensitive and must remain private. Cumulative budget is attached to that state
directory; it does not reset daily or on process restart. Alpha API changes may
occur before 1.0; pin a version and consult the [changelog](../CHANGELOG.md).
