# Sell an agent capability

EnvarPay charges for an MCP **tool call**. It does not require a particular agent
framework: expose the capability as a private MCP tool, then let the gate quote,
settle, verify the receipt and invoke it. Keep model credentials inside the runtime.

## Existing MCP service

Choose the exact tool name returned by your service:

```sh
envarpay init --agent mcp --role seller --directory ./paid-service \
  --pay-to YOUR_FULL_RECEIVING_ADDRESS \
  --upstream http://127.0.0.1:8000/mcp --tool summarize --price 0.01
envarpay serve --config ./paid-service/seller.toml
```

The gate discovers the tool's schema and forwards its result after payment. It
preserves text/content, structured content and metadata. This is tools/call
integration, not transparent forwarding of every MCP resource/prompt/sampling feature.

## Wrap a Python capability

Keep this wrapper in the runtime's own environment. A minimal MCP 1 example is:

```python
from mcp.server.fastmcp import FastMCP
from your_service import your_existing_agent  # your application's configured instance

server = FastMCP("private capabilities", host="127.0.0.1", port=8000)

@server.tool()
async def ask_agent(question: str) -> str:
    result = await your_existing_agent.run(question)
    return str(result)

server.run(transport="streamable-http")
```

Adapt the actual invocation/result extraction to your framework. Do not replace a
native agent with a generic model request and call that framework tested. Complete
runnable native LangChain and Pydantic AI versions are in
[python_agents.py](../examples/integrations/python_agents.py), with
[framework-specific setup guides](integrations/index.md).

The wrapper itself has no public payment check. Keep its URL private and point
`envarpay serve` at it. The outer gate supplies the x402 payment requirement.

## Native CLI seller in Docker

For OpenClaw, Hermes, OpenCode and Goose, the tested wrapper is
[native_cli.py](../examples/cross-framework/native_cli.py). It runs the actual
native CLI, accepts completed output and performs no automatic task retry.
These wrappers use dedicated profiles; they do not attach to a personal desktop chat.

### Prepare images and a dedicated profile

Build the appropriate image from the [official source recipes](../examples/cross-framework/README.md).
There is no implicitly downloaded EnvarPay runtime image. Image tags such as
`envarpay:matrix-hermes` refer to your locally built artifacts.

Set these operator-owned paths; choose one of `hermes`, `openclaw`, `opencode`, `goose`:

```sh
export ENVARPAY_AGENT=hermes
export ENVARPAY_REPO=/absolute/path/to/EnvarPay
export ENVARPAY_RUNTIME_DIR=/absolute/private/path/hermes-runtime
export ENVARPAY_MODEL_KEY_FILE=/absolute/private/path/model-api-key

umask 077
mkdir -p "$ENVARPAY_RUNTIME_DIR/home" "$ENVARPAY_RUNTIME_DIR/evidence"
cp -Rn "$ENVARPAY_REPO/examples/cross-framework/profiles/$ENVARPAY_AGENT/seller/." \
  "$ENVARPAY_RUNTIME_DIR/home/"
```

Use a new dedicated runtime directory outside your source repository. Review the
copied model/provider configuration and credential reference for your account.
`cp -Rn` does not overwrite an existing profile. Keep the model-key file owner-only.
Set `MODEL_BASE_URL` to the model provider URL you have reviewed; Goose's provider
uses it below. The other profiles keep their provider URL in the copied config.

### Start the private runtime

Create a dedicated Docker network without publishing the raw runtime's port:

```sh
docker network create envarpay-private

docker run -d --init --name envarpay-runtime --network envarpay-private \
  --entrypoint /opt/envarpay/.venv/bin/python \
  -e ENVARPAY_AGENT_ROLE=seller \
  -e OPENCODE_CONFIG=/runtime-home/opencode.json \
  -e OPENAI_BASE_URL="$MODEL_BASE_URL" \
  -v "$ENVARPAY_REPO/examples/cross-framework/native_cli.py:/harness/native_cli.py:ro" \
  -v "$ENVARPAY_RUNTIME_DIR/home:/runtime-home" \
  -v "$ENVARPAY_RUNTIME_DIR/evidence:/evidence" \
  -v "$ENVARPAY_MODEL_KEY_FILE:/run/secrets/llm_api_key:ro" \
  "envarpay:matrix-$ENVARPAY_AGENT" \
  /harness/native_cli.py seller --framework "$ENVARPAY_AGENT"
```

For OpenClaw, preserve `/runtime-home/workspace` with the profile on restart.
The private bridge network permits model-provider egress. Do not use Docker
`--internal` without separately planning egress, and do not mount the Docker socket.
If a proxy is needed, configure it explicitly and exclude private service names
from proxying with `NO_PROXY`.

### Put the gate in front

Generate the gate config using the host EnvarPay environment:

```sh
envarpay init --agent "$ENVARPAY_AGENT" --role seller \
  --directory "$ENVARPAY_RUNTIME_DIR/payment" \
  --pay-to YOUR_FULL_RECEIVING_ADDRESS \
  --upstream http://envarpay-runtime:8000/mcp --allow-http --price 0.01
```

In `payment/seller.toml`, edit the existing `[seller]` table to use
`host = "0.0.0.0"` and add `allowed_hosts = ["localhost:*", "127.0.0.1:*", "envarpay-gate:*"]`.
Keep the other recipient/price settings. TOML may quote table segments; the
meaning is the same. Then start the locally built SDK image:

```sh
mkdir -p "$ENVARPAY_RUNTIME_DIR/payment/seller-state"
chmod 700 "$ENVARPAY_RUNTIME_DIR/payment/seller-state"

docker run -d --init --name envarpay-gate --network envarpay-private \
  -p 127.0.0.1:4020:4020 \
  -v "$ENVARPAY_RUNTIME_DIR/payment/seller.toml:/config/seller.toml:ro" \
  -v "$ENVARPAY_RUNTIME_DIR/payment/seller-state:/config/seller-state" \
  envarpay:matrix-sdk serve --config /config/seller.toml
```

Buyers can now use the gate at `http://127.0.0.1:4020/mcp` on this host. Public use
needs an HTTPS proxy and an explicit public-host allowlist. The runtime itself
has no published host port; only the gate should be reachable by buyers.

Inspect `docker logs envarpay-runtime` and `docker logs envarpay-gate` if startup
fails. Do not restart a paid task to recover ambiguous execution. Stop the two
containers when finished while retaining their profiles, payment state and evidence.

## What this setup does not establish

A test-wallet receipt proves a payment, not a production custody boundary or
service-quality guarantee. A runtime with access to a buyer key under the same OS
identity is not isolated from it. The SDK has no automatic refunds, multi-host
coordinator or generic long-running-job recovery. Original-operation recovery for
approved peers is available separately; see [its semantics](directory-and-recovery.md). The existing Gateway HTTP
connectors are documented separately with their experimental status.
