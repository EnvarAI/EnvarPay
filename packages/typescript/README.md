# @envarai/envarpay

A TypeScript client for an existing **authenticated EnvarPay wallet MCP service**.
The client does not install Python, run a signer, hold wallet keys, or change wallet
policy. Use the Python CLI or a separately operated service for those responsibilities.

This client uses the alpha release channel. See
[installation channels](https://github.com/EnvarAI/EnvarPay/blob/main/docs/packages.md)
for the current registry status and available distributions.

## Install and start a wallet

Install the npm alpha client:

```sh
npm install @envarai/envarpay@next
```

If your project uses a custom package registry, route this scope to the public
registry in its `.npmrc`: `@envarai:registry=https://registry.npmjs.org/`.

Node.js >=22.14 and Bun are supported. Import this package from an ESM application.
The npm library is a client; the wallet runs as a separate service:

```sh
uv tool install --python 3.13 --prerelease allow envarpay
envarpay init --agent mcp --role buyer --directory ./buyer \
  --peer-url https://seller.example/mcp --pay-to SELLER_FULL_RECEIVING_ADDRESS \
  --tool ask_agent --max-per-call 0.01 --budget 0.05
envarpay keygen --output ./buyer/buyer.key
```

The generated policy uses Base Sepolia test USDC and payments off. Fund the
dedicated test wallet, review the recipient/tool/limits and enable payments only
for your intended purchases. The agent never receives the wallet key.

Create the wallet-access credential in your private operator environment. This
command never prints it and refuses to overwrite an existing file:

```sh
python3 - <<'PY'
import os, secrets
with os.fdopen(os.open('buyer/wallet-service.token', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as f:
    f.write(secrets.token_urlsafe(32))
PY
```

Add this table to the existing `buyer.toml`:

```toml
[wallet_server]
host = "127.0.0.1"
port = 4021
allowed_hosts = ["127.0.0.1:*", "localhost:*"]
bearer_token_file = "./wallet-service.token"
```

```sh
envarpay doctor --config ./buyer/buyer.toml
envarpay wallet-serve --config ./buyer/buyer.toml
```

For local development, connect to `http://127.0.0.1:4021/mcp`. For a separate wallet
permission boundary, run it under another OS identity/container or on a private
service with HTTPS; only the wallet receives its key, policy and ledger. Keep the
wallet service private. Give the client its wallet-access token, not a seller's
token or an Envar machine credential.

## Discover tools and make a purchase

```ts
import { WalletClient, OperationUnknownError } from '@envarai/envarpay';

const wallet = await WalletClient.connect({
  url: 'https://wallet.example/mcp',
  token: process.env.ENVARPAY_WALLET_TOKEN!,
});
try {
    const tools = await wallet.listPaidTools('approved-seller');
  console.log(tools.tools.map(tool => tool.name));
  // This may pay within the wallet operator's existing allowlist and budget.
  const result = await wallet.callPaidTool({
    peer: 'approved-seller', tool: 'ask_agent',
    arguments: { question: 'Review my API design' }, requestId: 'review-001',
  });
  console.log(result.result.content);
} catch (error) {
  if (error instanceof OperationUnknownError) {
    console.log(await wallet.paymentStatus(error.requestId));
    // When the operator-approved seller supports recovery:
    // await wallet.recoverPayment(error.requestId);
  } else throw error;
} finally {
  await wallet.close();
}
```

Use the alias actually configured in `buyer.toml` (the quickstart generates `seller`).
`listPaidTools` does not pay. `callPaidTool` may spend within the existing wallet
policy; `paymentStatus` and `recoverPayment` retain the original purchase.

## Envar discovery and transaction pages

With the optional `[connection]` in the wallet, these additional methods read
Envar's public catalog:

```ts
const candidates = await wallet.discoverAgents('research');
console.log(candidates.payment_authorized); // always false
const profile = await wallet.getAgent('THE_PUBLISHED_AGENT_HANDLE');
```

The operator still approves and configures a peer before purchasing from it.
The Python wallet handles optional durable Envar reports; the npm client does not
duplicate signing, settlement or the platform's payment verification.
[Complete Envar setup](https://github.com/EnvarAI/EnvarPay/blob/main/docs/envar.md).

## Receiving and asynchronous tasks

For **receiving**, put the Python `envarpay` payment gate in front of your existing
private JS/TS MCP tool and expose only the gate through HTTPS. No buyer-wallet
client is needed to receive payments; the seller does not need a signing key.
[Seller quickstart](https://github.com/EnvarAI/EnvarPay/blob/main/docs/selling.md).

For **asynchronous escrow/acceptance/refunds**, use Python `envarpay[task]` and
`envarpay task wallet` with your host's standard MCP client. The task mode is an
experimental Base Sepolia-only flow, separate from this upfront wallet API.
[Task guide](https://github.com/EnvarAI/EnvarPay/blob/main/docs/tasks/README.md).

## Errors and recovery

Persist the request ID in your application before calling. Never replace it after
an uncertain result. The client does not retry paid calls; the wallet retains the
original authorization and ledger. A `WalletToolError` preserves an explicit
wallet refusal/execution error. An `OperationUnknownError` means the result is
uncertain, including transport failures and timeouts; it does not mean no payment occurred.

HTTPS is required except for loopback HTTP. Redirects are rejected, including
redirects to another wallet URL. The bearer token belongs to the wallet service,
not to a seller or public directory; keep it in the application's private config.

Targets Node.js >=22.14 and Bun. Local tests use the actual Python wallet MCP
adapter with a fake service and transfer no funds; they are not real payment evidence.
This client has no task-escrow API or framework-native plugin manifest.

## Reviewed purchases from Envar

Run Python EnvarPay 0.1.0a8 or newer for these methods. `walletPolicy()` reads limits
and already-approved peers. `callAgent()` selects only a peer bound to the reviewed
Agent and endpoint IDs; it never adds a directory candidate to wallet policy. Supply
`expectedNetwork`, `expectedPayTo` and `expectedAmountAtomic` from the terms you
reviewed. A different live price is refused before signing. Keep `requestId` across
uncertain outcomes and use the original status/recovery methods.

The website can use the same authenticated wallet through its owner-only entry.
For task creation, result verification and acceptance/refunds, connect the private
`envarpay task wallet-serve` using a standard MCP client. The task signer and
contract verification stay in Python; the task mode remains experimental/testnet.
