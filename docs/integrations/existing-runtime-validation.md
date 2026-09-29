# Existing runtime connection acceptance

Validated locally on 2026-09-29 against the P3 source and its freshly built
`envarpay-0.1.0a2` wheel. The wheel was installed from scratch with dependencies
from PyPI; its complete test suite passed **76 tests**. MCP is pinned to 1.28.1.

Two independent native Hermes gateway processes ran from official source
`NousResearch/hermes-agent@fc042f1d67bc393bf43920e92d4eb5082eddedfb` in local Docker.
The existing source image needed the API server's optional `aiohttp` dependency;
adding aiohttp 3.14.3 enabled the native adapter. The resulting test image digest
was `sha256:98d161962ffb7ee4a2f6e8eb1653f53060da1a21978791d677d68c1905a336d2`.
Hermes' source package reports 0.0.0, so the source commit and image identify this
run rather than that placeholder version. No embedded Agent was created by EnvarPay.

Both native `/v1/responses` services completed a real model call and returned
`37 + 58 = 95` with their distinct requested markers. Then the clean wheel's
`init --mode private --backend hermes-http`, `doctor` and `serve` path exposed only
`ask_agent` over authenticated MCP Streamable HTTP. An unauthenticated request
returned HTTP 401. The authenticated official MCP client received the native
Hermes answer `19 × 7 = 133. ENVAR_CONNECTED_HTTP_MCP_20260929.`

The gateway, bearer and model credentials stayed on the user's machine. The raw
Hermes HTTP services were bound only to host loopback. The MCP service did not
receive a wallet key. This verifies private connection and actual model delivery;
it does **not** claim a payment, public tunnel, platform account association or
seller income. Those are the dependent platform/payment acceptance steps.

For an existing source checkout, install the native API-server requirements
before starting `hermes gateway run`. Configure its API key and model in Hermes,
then point EnvarPay at that service. `doctor` checks configuration, not delivery.
