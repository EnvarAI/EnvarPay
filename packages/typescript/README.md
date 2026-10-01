# @envarai/envarpay

A TypeScript client for an existing **authenticated EnvarPay wallet MCP service**.
The client does not install Python, run a signer, hold wallet keys, or change wallet
policy. Use the Python CLI or a separately operated service for those responsibilities.

This client uses the alpha release channel. See
[installation channels](https://github.com/EnvarAI/EnvarPay/blob/main/docs/packages.md)
for the current registry status and available distributions.

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
