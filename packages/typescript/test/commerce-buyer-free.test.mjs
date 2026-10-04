import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Task } from '@a2a-js/sdk';
import { CommerceBuyer } from '../dist/commerce/buyer.js';
import { BuyerStore } from '../dist/commerce/buyer-store.js';
import { CredentialVault } from '../dist/commerce/vault.js';
import { CommerceStore, CommerceServer, bearerAuthenticator } from '../dist/commerce/runtime.js';
import { loadBuyerPolicy, loadCommerceConfig } from '../dist/commerce/config.js';
const origin = 'https://seller.example', token = 'a'.repeat(40), cardUrl = origin + '/services/summary-preview/v1/offers/free/agent-card.json';
const policy = { policyVersion: 1, paymentsEnabled: false, approval: 'per_purchase', peers: [{ id: 'preview', cardUrl, protocol: 'free', currency: null, recipient: null, maxPerPurchase: '0' }], budgets: [] };
function fixture(options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'envar-free-buyer-')), sellerStore = new CommerceStore(':memory:');
  let store = new BuyerStore(join(directory, 'buyer.sqlite3'));
  const vault = new CredentialVault(join(directory, 'vault'), Buffer.alloc(32, 5));
  const calls = { card: 0, send: 0, execute: 0, bodies: [] }; let lose = options.lose ?? false;
  const config = loadCommerceConfig(JSON.parse(readFileSync(new URL('../examples/seller.json', import.meta.url), 'utf8')));
  if (options.waiting) config.services[1].contract.inputSchema.properties.clarification = { type: 'string' };
  const seller = new CommerceServer({ config, origin, store: sellerStore, authenticate: bearerAuthenticator({ [token]: 'buyer' }), execute: async function* (order) { calls.execute++; yield Task.fromJSON({ id: 'remote-' + order.id, status: { state: options.waiting ? 'TASK_STATE_INPUT_REQUIRED' : 'TASK_STATE_COMPLETED' }, artifacts: [{ artifactId: 'summary', parts: [{ text: 'free fixture' }] }] }); } });
  const fetchImpl = async (input, init) => {
    const request = new Request(input, init); assert.equal(request.headers.has('PAYMENT-SIGNATURE'), false); assert.equal(request.headers.has('Payment-Authorization'), false);
    if (request.method === 'GET') { calls.card++; const response = await seller.handle(request); if (options.paidCard) { const body = await response.json(); body.capabilities.extensions[0].params.pricing = { kind: 'fixed', amount: '1' }; return Response.json(body); } return response; }
    const raw = await request.clone().json();
    if (raw.method === 'SendMessage') { calls.send++; calls.bodies.push(await request.clone().text()); }
    if (raw.params?.message?.taskId) return Response.json({ jsonrpc: '2.0', id: raw.id, result: { task: { id: raw.params.message.taskId, status: { state: 'TASK_STATE_COMPLETED' }, history: [raw.params.message] } } });
    const response = await seller.handle(request); if (lose && raw.method === 'SendMessage') { lose = false; throw new Error('free response lost'); } return response;
  };
  const opts = { policy, store, vault, peerTokens: { preview: token }, fetchImpl };
  let buyer = new CommerceBuyer(opts);
  return { calls, seller, get buyer() { return buyer; }, get store() { return store; }, restart() { store.close(); store = new BuyerStore(join(directory, 'buyer.sqlite3')); buyer = new CommerceBuyer({ ...opts, store }); }, close: async () => { await buyer.stop(); seller.stop(); while (seller.isRunning) await new Promise(r => setTimeout(r, 1)); store.close(); sellerStore.close(); rmSync(directory, { recursive: true, force: true }); } };
}
const request = { cardUrl, messageId: 'free-one', offerId: 'free', input: { text: 'Summarize this' } };
const confirm = (buyer, p) => buyer.confirm('owner', { previewId: p.id, quoteToken: p.quoteToken, messageId: p.messageId });

test('free-only policy needs no currencies, budget or signer and rejects accidental paid semantics', () => {
  assert.deepEqual(loadBuyerPolicy(policy), policy);
  for (const patch of [{ currency: 'usd' }, { recipient: 'profile_test' }, { maxPerPurchase: '1' }]) assert.throws(() => loadBuyerPolicy({ ...policy, peers: [{ ...policy.peers[0], ...patch }] }), { code: 'invalid_policy' });
  assert.throws(() => loadBuyerPolicy({ ...policy, peers: [{ ...policy.peers[0], protocol: 'mpp' }] }), { code: 'invalid_policy' });
});
test('free preview only reads Card; confirm runs once with not_required payment', async () => {
  const f = fixture(); try {
    const preview = await f.buyer.preview('owner', request); assert.equal(f.calls.send, 0); assert.equal(f.calls.execute, 0); assert.equal(preview.quote.amount, '0'); assert.equal(preview.quote.currency, null);
    await Promise.all(Array.from({ length: 5 }, () => confirm(f.buyer, preview)));
    while (f.seller.isRunning) await new Promise(r => setTimeout(r, 1));
    const done = await f.buyer.recover('owner', preview.id); assert.equal(done.paymentState, 'not_required'); assert.equal(done.executionState, 'completed'); assert.equal(f.calls.send, 1); assert.equal(f.calls.execute, 1); assert.deepEqual(f.buyer.policySnapshot().budgets, []);
  } finally { await f.close(); }
});
test('free lost response restarts with original request only and no new execution', async () => {
  const f = fixture({ lose: true }); try {
    const preview = await f.buyer.preview('owner', request); assert.equal((await confirm(f.buyer, preview)).state, 'unknown');
    f.restart(); const recovered = await f.buyer.recover('owner', preview.id); assert.equal(recovered.paymentState, 'not_required'); assert.equal(f.calls.send, 2); assert.equal(f.calls.execute, 1); assert.equal(f.calls.bodies[0], f.calls.bodies[1]);
  } finally { await f.close(); }
});
test('free peer rejects paid Card before sending work and supports bound free clarification', async () => {
  const bad = fixture({ paidCard: true }); try { await assert.rejects(bad.buyer.preview('owner', request), { code: 'free_offer_required' }); assert.equal(bad.calls.send, 0); } finally { await bad.close(); }
  const f = fixture({ waiting: true }); try {
    const preview = await f.buyer.preview('owner', request); await confirm(f.buyer, preview); while (f.seller.isRunning) await new Promise(r => setTimeout(r, 1));
    await f.buyer.recover('owner', preview.id);
    const done = await f.buyer.continue('owner', preview.id, { messageId: 'free-round', input: { ...request.input, clarification: 'short' } });
    assert.equal(done.executionState, 'completed'); assert.equal(done.paymentState, 'not_required'); assert.equal(done.continuation.state, 'resolved'); assert.equal(f.calls.execute, 1);
  } finally { await f.close(); }
});
