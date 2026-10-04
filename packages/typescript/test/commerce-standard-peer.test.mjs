import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentCard, Task, Message } from '@a2a-js/sdk';
import { AgentEvent, DefaultRequestHandler, InMemoryTaskStore, JsonRpcTransportHandler, ServerCallContext } from '@a2a-js/sdk/server';
import { x402ResourceServer } from '@x402/core/server';
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from '@x402/core/http';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { CommerceBuyer } from '../dist/commerce/buyer.js';
import { BuyerStore } from '../dist/commerce/buyer-store.js';
import { CredentialVault } from '../dist/commerce/vault.js';
import { loadBuyerPolicy } from '../dist/commerce/config.js';

// Independent third-party wire fixture: the seller uses official A2A/x402 SDKs,
// never CommerceServer/X402Gate or EnvarPay Card/quote extensions. The signer,
// facilitator and chain verifier below are synthetic; these are not real payments.
const network = 'eip155:84532';
const asset = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const payer = '0x' + '1'.repeat(40), recipient = '0x' + '2'.repeat(40);
const currency = `${network}/erc20:${asset.toLowerCase()}`;
const cardUrl = 'https://third.example/.well-known/agent-card.json';
const endpoint = 'https://third.example/a2a';
const token = 'test-only-peer-token-that-must-not-leak';
const transaction = '0x' + '5'.repeat(64);
const inputSchema = {
  type: 'object', additionalProperties: false, required: ['text'],
  properties: { text: { type: 'string', maxLength: 256 } },
};
const policy = () => ({
  policyVersion: 1, paymentsEnabled: true, approval: 'per_purchase',
  peers: [{
    id: 'third-party', mode: 'standard-a2a', protocol: 'x402', cardUrl, endpoint,
    authentication: 'none', currency, recipient, maxPerPurchase: '100',
    localContract: { revision: 1, offerId: 'research', inputSchema, amount: '100', paidOnly: true },
  }],
  budgets: [{ currency, maxTotal: '200', period: 'cumulative' }],
});
const previewInput = (messageId = 'original-standard-request') => ({
  cardUrl, messageId, offerId: 'research', input: { text: 'Compute 19 times 23' },
});
const confirm = (buyer, preview) => buyer.confirm('owner', {
  previewId: preview.id, quoteToken: preview.quoteToken, messageId: preview.messageId,
});

async function fixture(options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'envar-standard-peer-'));
  const localPolicy = structuredClone(options.policy ?? policy());
  const calls = { sign: 0, settle: 0, execute: 0, reads: 0, reconcile: 0, requests: [], unsignedBodies: [], paidBodies: [], paidHeaders: [], order: [] };
  let store = new BuyerStore(join(directory, 'buyer.sqlite3'));
  let lost = options.losePaidResponse ?? false, receiptReady = options.receiptReady ?? true;
  let originalReceipt;
  const bearer = options.cardAuthentication === 'bearer' || localPolicy.peers[0].authentication === 'bearer';
  const card = AgentCard.fromJSON({
    name: 'Independent standard A2A seller', description: 'Third-party task endpoint', version: '1',
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ['application/json'], defaultOutputModes: ['text/plain'],
    supportedInterfaces: [{ url: endpoint, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
    skills: [{ id: 'calculate', name: 'Calculate', description: 'Calculate the requested value', tags: ['calculate'] }],
    ...(bearer ? { securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: 'bearer' } } }, securityRequirements: [{ schemes: { bearer: { list: [] } } }] } : {}),
  });
  const tasks = new InMemoryTaskStore();
  const executor = {
    execute: async (context, events) => {
      calls.execute++; calls.order.push('execute');
      assert.ok(calls.settle > 0, 'the independent seller executes only after settlement');
      const data = context.userMessage.parts[0]?.content;
      assert.equal(data?.$case, 'data');
      assert.deepEqual(data.value, previewInput().input);
      if (options.messageResult) {
        events.publish(AgentEvent.message(Message.fromJSON({ messageId: 'independent-message', contextId: context.contextId,
          role: 'ROLE_AGENT', parts: [{ text: 'Immediate independent result: 437' }] })));
        return;
      }
      events.publish(AgentEvent.task(Task.fromJSON({
        id: context.taskId, contextId: context.contextId,
        status: { state: 'TASK_STATE_COMPLETED' }, history: [context.userMessage],
        artifacts: [{ artifactId: 'result', parts: [{ text: '19 × 23 = 437, independently executed' }] }],
      })));
    },
    cancelTask: async () => { throw new Error('Not supported by this fixture'); },
  };
  const rpc = new JsonRpcTransportHandler(new DefaultRequestHandler(card, tasks, executor));
  const context = () => new ServerCallContext({ user: { isAuthenticated: true, userName: 'fixture-payer' }, requestedVersion: '1.0' });
  const facilitator = {
    getSupported: async () => ({ kinds: [{ x402Version: 2, scheme: 'exact', network }], extensions: [], signers: {} }),
    verify: async () => ({ isValid: true, payer }),
    settle: async () => {
      calls.settle++; calls.order.push('settle');
      originalReceipt = { success: true, payer, network, transaction };
      return originalReceipt;
    },
  };
  const payments = new x402ResourceServer(facilitator).register(network, new ExactEvmScheme());
  await payments.initialize();
  const requirements = await payments.buildPaymentRequirements({
    scheme: 'exact', network, payTo: recipient,
    price: { asset, amount: '100', extra: { name: 'USDC', version: '2' } },
    maxTimeoutSeconds: 60, extra: { paymentFlow: 'upfront', assetTransferMethod: 'eip3009' },
  });
  const challenge = await payments.createPaymentRequiredResponse(requirements, {
    url: endpoint, description: 'Independent task purchase', mimeType: 'application/json',
  });
  options.mutateChallenge?.(challenge);
  assert.equal(Object.keys(challenge.extensions ?? {}).some(key => key.startsWith('urn:envarpay:')), false);
  assert.equal(card.capabilities.extensions.some(extension => extension.uri.startsWith('urn:envarpay:')), false);

  const fetchImpl = async (input, init) => {
    const request = new Request(input, init);
    calls.requests.push({ url: request.url, method: request.method, authorization: request.headers.get('Authorization') });
    assert.ok([cardUrl, endpoint].includes(request.url), 'credentials and requests stay on the two reviewed URLs');
    if (request.method === 'GET') return Response.json(AgentCard.toJSON(card));
    assert.equal(request.headers.get('A2A-Version'), '1.0');
    const body = await request.text(), parsed = JSON.parse(body);
    if (parsed.method === 'GetTask') {
      calls.reads++; assert.equal(request.headers.has('PAYMENT-SIGNATURE'), false);
      return Response.json(await rpc.handle(body, context()));
    }
    assert.equal(parsed.method, 'SendMessage');
    const signature = request.headers.get('PAYMENT-SIGNATURE');
    if (!signature) {
      calls.unsignedBodies.push(body);
      return new Response('{}', { status: 402, headers: { 'Content-Type': 'application/json', 'PAYMENT-REQUIRED': encodePaymentRequiredHeader(challenge) } });
    }
    calls.paidBodies.push(body); calls.paidHeaders.push(signature);
    const payload = decodePaymentSignatureHeader(signature);
    assert.equal(payload.resource.url, endpoint);
    assert.equal(Object.keys(payload.extensions ?? {}).some(key => key.startsWith('urn:envarpay:')), false);
    const matched = payments.findMatchingRequirements(challenge.accepts, payload);
    assert.ok(matched, 'official server must recognize the official client payment');
    await payments.verifyPayment(payload, matched);
    const settled = await payments.settlePayment(payload, matched, undefined, undefined, undefined, 'before-handler');
    assert.equal(settled.success, true);
    const result = await rpc.handle(body, context());
    if (options.wrongRpcId) result.id = 'different-request';
    if (lost) { lost = false; throw new Error('Original response lost after independent execution'); }
    return Response.json(result, { headers: { 'PAYMENT-RESPONSE': encodePaymentResponseHeader(settled) } });
  };
  const buyerOptions = {
    policy: localPolicy, vault: new CredentialVault(join(directory, 'vault'), Buffer.alloc(32, 4)),
    signer: { address: payer, signTypedData: async () => { calls.sign++; return '0x' + '6'.repeat(130); } },
    // Deliberately present even for anonymous peers: mode=none must never send it.
    peerTokens: { 'third-party': token }, peerEndpoints: { 'third-party': endpoint }, fetchImpl,
    checkpoint: async () => '100',
    verifyReceipt: async (receipt, payload, terms) => receiptReady && receipt.transaction === transaction &&
      receipt.network === network && payload.payload.authorization.from.toLowerCase() === payer &&
      terms.amount === '100' && terms.payTo.toLowerCase() === recipient,
    findOriginalReceipt: async () => { calls.reconcile++; return originalReceipt; },
  };
  let buyer = new CommerceBuyer({ ...buyerOptions, store });
  return {
    calls, card, challenge, get buyer() { return buyer; }, get store() { return store; },
    ready: () => { receiptReady = true; },
    restart: async () => { await buyer.stop(); store.close(); store = new BuyerStore(join(directory, 'buyer.sqlite3')); buyer = new CommerceBuyer({ ...buyerOptions, store }); },
    close: async () => { await buyer.stop(); store.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}

async function completed(f, value) {
  for (let i = 0; i < 10 && value.executionState !== 'completed'; i++) {
    await new Promise(resolve => setTimeout(resolve, 1));
    value = await f.buyer.recover('owner', value.id);
  }
  assert.equal(value.executionState, 'completed');
  return value;
}

test('explicit standard peer buys an independent official A2A/x402 seller without Envar metadata or bearer leakage', async () => {
  const f = await fixture();
  try {
    const preview = await f.buyer.preview('owner', previewInput());
    assert.equal(preview.quote.termsSource, 'local-policy');
    assert.equal(preview.quote.amount, '100'); assert.equal(preview.quote.recipient, recipient);
    assert.equal(f.calls.sign, 0); assert.equal(f.calls.execute, 0);
    const result = await completed(f, await confirm(f.buyer, preview));
    assert.equal(result.paymentState, 'confirmed');
    assert.equal(result.task.artifacts[0].parts[0].text, '19 × 23 = 437, independently executed');
    assert.equal(f.calls.sign, 1); assert.equal(f.calls.settle, 1); assert.equal(f.calls.execute, 1);
    assert.deepEqual(f.calls.order, ['settle', 'execute']);
    assert.deepEqual(f.calls.paidBodies, f.calls.unsignedBodies);
    assert.ok(f.calls.requests.every(request => request.authorization === null));
    assert.deepEqual(f.store.usage(currency), { reserved: '0', spent: '100' });
  } finally { await f.close(); }
});

test('standard peer bearer authentication is explicit and remains separate from payment', async () => {
  const configured = policy(); configured.peers[0].authentication = 'bearer';
  const f = await fixture({ policy: configured });
  try {
    const result = await completed(f, await confirm(f.buyer, await f.buyer.preview('owner', previewInput())));
    assert.equal(result.paymentState, 'confirmed');
    assert.ok(f.calls.requests.every(request => request.authorization === `Bearer ${token}`));
    assert.equal(f.calls.sign, 1); assert.equal(f.calls.execute, 1);
  } finally { await f.close(); }
});

test('standard native challenge does not require EnvarPay flow hints', async () => {
  const f = await fixture({ mutateChallenge: challenge => { delete challenge.accepts[0].extra.paymentFlow; delete challenge.accepts[0].extra.assetTransferMethod; } });
  try {
    const result = await completed(f, await confirm(f.buyer, await f.buyer.preview('owner', previewInput())));
    assert.equal(result.paymentState, 'confirmed'); assert.equal(f.calls.execute, 1); assert.equal(f.calls.sign, 1);
  } finally { await f.close(); }
});

test('immediate standard A2A Message is preserved without inventing a remote Task', async () => {
  const f = await fixture({ messageResult: true });
  try {
    const result = await confirm(f.buyer, await f.buyer.preview('owner', previewInput()));
    assert.equal(result.paymentState, 'confirmed'); assert.equal(result.executionState, 'completed');
    assert.equal(result.task, undefined); assert.equal(result.result.message.messageId, 'independent-message');
    assert.equal(result.result.message.parts[0].text, 'Immediate independent result: 437');
    await f.restart();
    assert.deepEqual((await f.buyer.recover('owner', result.id)).result, result.result);
    assert.equal(f.calls.paidBodies.length, 1); assert.equal(f.calls.sign, 1);
  } finally { await f.close(); }
});

test('a mismatched JSON-RPC reply keeps original payment evidence but cannot bind another Task', async () => {
  const f = await fixture({ wrongRpcId: true });
  try {
    const result = await confirm(f.buyer, await f.buyer.preview('owner', previewInput()));
    assert.equal(result.paymentState, 'confirmed'); assert.equal(result.state, 'unknown'); assert.equal(result.task, undefined);
    assert.equal(result.errorCode, 'rpc_response_binding');
    await f.restart(); const recovered = await f.buyer.recover('owner', result.id);
    assert.equal(recovered.nonce, result.nonce); assert.equal(recovered.receipt.transaction, result.receipt.transaction);
    assert.equal(recovered.errorCode, 'standard_task_recovery_required');
    assert.equal(f.calls.paidBodies.length, 1); assert.equal(f.calls.sign, 1); assert.equal(f.calls.execute, 1);
  } finally { await f.close(); }
});

test('standard mode refuses incompatible declared authentication before requesting payment', async () => {
  const f = await fixture({ cardAuthentication: 'bearer' });
  try {
    await assert.rejects(f.buyer.preview('owner', previewInput()));
    assert.equal(f.calls.unsignedBodies.length, 0); assert.equal(f.calls.sign, 0);
    assert.ok(f.calls.requests.every(request => request.authorization === null));
  } finally { await f.close(); }
});

test('ordinary cards do not silently downgrade the existing strict EnvarPay peer mode', async () => {
  const strict = policy();
  delete strict.peers[0].mode; delete strict.peers[0].endpoint;
  delete strict.peers[0].authentication; delete strict.peers[0].localContract;
  const f = await fixture({ policy: strict });
  try {
    await assert.rejects(f.buyer.preview('owner', previewInput()), { code: 'offer_metadata_required' });
    assert.equal(f.calls.sign, 0); assert.equal(f.calls.execute, 0);
  } finally { await f.close(); }
});

test('standard peer challenges cannot alter payee, amount, resource, network, asset or timeout', async () => {
  const changes = {
    payee: challenge => { challenge.accepts[0].payTo = '0x' + '3'.repeat(40); },
    amount: challenge => { challenge.accepts[0].amount = '101'; },
    resourcePath: challenge => { challenge.resource.url = 'https://third.example/another-task'; },
    resourceOrigin: challenge => { challenge.resource.url = 'https://another.example/a2a'; },
    resourceQuery: challenge => { challenge.resource.url = endpoint + '?unreviewed=1'; },
    asset: challenge => { challenge.accepts[0].asset = '0x' + '4'.repeat(40); },
    network: challenge => { challenge.accepts[0].network = 'eip155:8453'; },
    expiredTimeout: challenge => { challenge.accepts[0].maxTimeoutSeconds = 0; },
    excessiveTimeout: challenge => { challenge.accepts[0].maxTimeoutSeconds = 301; },
    signingDomain: challenge => { challenge.accepts[0].extra.name = 'Unapproved Token'; },
  };
  for (const [name, mutateChallenge] of Object.entries(changes)) {
    const f = await fixture({ mutateChallenge });
    try {
      await assert.rejects(f.buyer.preview('owner', previewInput()), undefined, name);
      assert.equal(f.calls.sign, 0, name); assert.equal(f.calls.settle, 0, name); assert.equal(f.calls.execute, 0, name);
      assert.deepEqual(f.store.usage(currency), { reserved: '0', spent: '0' }, name);
    } finally { await f.close(); }
  }
});

test('local contract input and explicit paid-only policy are checked before sending work', async () => {
  for (const patch of [peer => { delete peer.localContract; }, peer => { peer.localContract.paidOnly = false; }, peer => { peer.protocol = 'free'; }]) {
    const invalid = policy(); patch(invalid.peers[0]);
    assert.throws(() => loadBuyerPolicy(invalid));
  }
  const f = await fixture();
  try {
    await assert.rejects(f.buyer.preview('owner', { ...previewInput(), input: { text: 'x', unexpected: true } }));
    assert.equal(f.calls.unsignedBodies.length, 0); assert.equal(f.calls.execute, 0); assert.equal(f.calls.sign, 0);
  } finally { await f.close(); }
});

test('changing the locally approved contract or peer mode after preview blocks signing', async () => {
  const changes = {
    amount: peer => { peer.localContract.amount = '99'; },
    revision: peer => { peer.localContract.revision = 2; },
    offer: peer => { peer.localContract.offerId = 'different-offer'; },
    schema: peer => { peer.localContract.inputSchema.properties.text.maxLength = 128; },
    authentication: peer => { peer.authentication = 'bearer'; },
    mode: peer => { peer.mode = 'envarpay'; },
  };
  for (const [name, change] of Object.entries(changes)) {
    const f = await fixture();
    try {
      const preview = await f.buyer.preview('owner', previewInput());
      change(f.buyer.policy.peers[0]);
      await assert.rejects(confirm(f.buyer, preview), undefined, name);
      assert.equal(f.calls.sign, 0, name); assert.equal(f.calls.execute, 0, name);
      assert.deepEqual(f.store.usage(currency), { reserved: '0', spent: '0' }, name);
    } finally { await f.close(); }
  }
});

test('expired local review cannot sign the captured standard challenge', async () => {
  const f = await fixture(); const now = Date.now;
  try {
    const preview = await f.buyer.preview('owner', previewInput());
    Date.now = () => Date.parse(preview.quote.expiresAt) + 1;
    await assert.rejects(confirm(f.buyer, preview), { code: 'quote_expired' });
    assert.equal(f.calls.sign, 0); assert.equal(f.calls.settle, 0);
  } finally { Date.now = now; await f.close(); }
});

test('lost standard paid response survives restart without replaying SendMessage or signing again', async () => {
  const f = await fixture({ losePaidResponse: true });
  try {
    const preview = await f.buyer.preview('owner', previewInput());
    const unknown = await confirm(f.buyer, preview);
    assert.equal(unknown.state, 'unknown');
    const original = f.store.get(unknown.id, 'owner');
    assert.ok(original.nonce); assert.ok(original.credentialRef);
    assert.equal(f.calls.paidBodies.length, 1); assert.equal(f.calls.sign, 1);
    await f.restart();
    for (let i = 0; i < 2; i++) {
      const recovered = await f.buyer.recover('owner', unknown.id);
      assert.equal(recovered.errorCode, 'standard_task_recovery_required');
      assert.equal(recovered.state, 'unknown'); assert.equal(recovered.paymentState, 'confirmed');
      const saved = f.store.get(unknown.id, 'owner');
      assert.equal(saved.nonce, original.nonce); assert.equal(saved.credentialRef, original.credentialRef);
      assert.equal(saved.body, original.body); assert.equal(saved.messageId, original.messageId);
    }
    await confirm(f.buyer, preview);
    assert.equal(f.calls.paidBodies.length, 1); assert.equal(f.calls.sign, 1);
    assert.equal(f.calls.settle, 1); assert.equal(f.calls.execute, 1); assert.equal(f.calls.reads, 0);
    assert.deepEqual(f.store.usage(currency), { reserved: '0', spent: '100' });
  } finally { await f.close(); }
});

test('known original standard Task recovers by GetTask and original receipt verification only', async () => {
  const f = await fixture({ receiptReady: false });
  try {
    const preview = await f.buyer.preview('owner', previewInput());
    const pending = await confirm(f.buyer, preview);
    assert.ok(pending.task?.id); assert.equal(pending.paymentState, 'unknown');
    const original = f.store.get(pending.id, 'owner');
    f.ready(); await f.restart();
    const recovered = await completed(f, await f.buyer.recover('owner', pending.id));
    assert.equal(recovered.paymentState, 'confirmed'); assert.equal(recovered.task.id, pending.task.id);
    assert.equal(f.store.get(pending.id, 'owner').nonce, original.nonce);
    assert.ok(f.calls.reads > 0); assert.equal(f.calls.sign, 1); assert.equal(f.calls.paidBodies.length, 1);
    assert.equal(f.calls.settle, 1); assert.equal(f.calls.execute, 1);
  } finally { await f.close(); }
});
