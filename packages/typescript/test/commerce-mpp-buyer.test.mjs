import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Task } from '@a2a-js/sdk';
import { Challenge, Credential } from 'mppx';
import { CommerceBuyer } from '../dist/commerce/buyer.js';
import { BuyerStore } from '../dist/commerce/buyer-store.js';
import { CredentialVault } from '../dist/commerce/vault.js';
import { CommerceStore, CommerceServer, bearerAuthenticator } from '../dist/commerce/runtime.js';
import { MppGate } from '../dist/commerce/mpp.js';
import { loadCommerceConfig } from '../dist/commerce/config.js';

const origin = 'https://seller.example', token = 'a'.repeat(40), cardUrl = origin + '/services/research/v1/offers/card-once/agent-card.json';
const policy = { policyVersion: 1, paymentsEnabled: true, approval: 'per_purchase', peers: [{ id: 'seller', cardUrl, protocol: 'mpp', currency: 'usd', recipient: 'profile_test', maxPerPurchase: '300' }], budgets: [{ currency: 'usd', maxTotal: '600', period: 'cumulative' }] };
const input = (messageId = 'mpp-one') => ({ cardUrl, messageId, offerId: 'card-once', input: { topic: 'x', competitors: ['A'] } });
const confirm = (buyer, preview, caller = 'owner') => buyer.confirm(caller, { previewId: preview.id, quoteToken: preview.quoteToken, messageId: preview.messageId });
function fixture(options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'envar-mpp-buyer-')), sellerStore = new CommerceStore(':memory:');
  const vault = new CredentialVault(join(directory, 'vault'), Buffer.alloc(32, 8)), sellerVault = new CredentialVault(join(directory, 'seller-vault'), Buffer.alloc(32, 9));
  let store = new BuyerStore(join(directory, 'buyer.sqlite3'));
  const calls = { createToken: [], recoverToken: [], create: [], verify: 0, execute: 0, paidBodies: [], credentials: [], bearer: [] }, intents = new Map(), tokens = new Map();
  let loseToken = options.loseToken ?? false, loseResponse = options.loseResponse ?? false, ready = options.receiptReady ?? true;
  const provider = { accountId: 'acct_test', merchantProfile: 'profile_test', mode: 'test', assertReady: async () => {},
    create: async (params, requestOptions) => { calls.create.push({ params, requestOptions }); const intent = { id: 'pi_test' + calls.create.length, status: 'succeeded', amount: params.amount, amount_received: params.amount, currency: params.currency, livemode: false, metadata: params.metadata }; intents.set(intent.id, intent); return intent; },
    retrieve: async id => intents.get(id), findOriginal: async id => [...intents.values()].find(value => value.metadata.envarpay_order === id) };
  const gate = new MppGate({ store: sellerStore, vault: sellerVault, origin, hmacSecret: 'test-only-secret-at-least-32-characters', providers: { 'seller-stripe': provider } });
  const config = loadCommerceConfig(JSON.parse(readFileSync(new URL('../examples/seller.json', import.meta.url), 'utf8')));
  const seller = new CommerceServer({ config, origin, store: sellerStore, authenticate: bearerAuthenticator({ [token]: 'buyer' }), paymentGate: gate, stripeRecipientFor: () => 'profile_test', execute: async function* (order) { calls.execute++; yield Task.fromJSON({ id: 'remote-' + order.id, status: { state: 'TASK_STATE_COMPLETED' }, artifacts: [{ artifactId: 'a', parts: [{ text: 'simulated delivery' }] }] }); } });
  const fetchImpl = async (input, init) => {
    const request = new Request(input, init);
    const result = await seller.handle(request.clone());
    if (request.headers.has('Payment-Authorization')) {
      calls.paidBodies.push(await request.text()); calls.credentials.push(request.headers.get('Payment-Authorization')); calls.bearer.push(request.headers.get('Authorization'));
      if (loseResponse) { loseResponse = false; throw new Error('lost paid response'); }
    }
    if (options.mutateChallenge && result.status === 402) {
      const challenge = Challenge.fromResponse(result); options.mutateChallenge(challenge);
      return new Response('{}', { status: 402, headers: { 'WWW-Authenticate': Challenge.serialize(challenge) } });
    }
    return result;
  };
  const mpp = { payer: 'buyer_test', mode: 'test', paymentMethod: 'pm_authorized',
    createToken: async operation => { calls.createToken.push(operation); const value = 'spt_test_' + calls.createToken.length; tokens.set(operation.operationId, value); if (loseToken) { loseToken = false; throw new Error('token response lost'); } return value; },
    recoverToken: async operation => { calls.recoverToken.push(operation); return tokens.get(operation.operationId); },
    verifyReceipt: async (receipt, context) => { calls.verify++; const intent = intents.get(receipt.reference); return ready && intent?.amount_received === Number(context.quote.amount) && intent.metadata.envarpay_quote === context.quote.quoteId && context.mode === 'test'; } };
  const buyerOptions = { policy: options.policy ?? policy, vault, store, mpp, peerTokens: { seller: token }, fetchImpl };
  let buyer = new CommerceBuyer(buyerOptions);
  return { directory, calls, intents, tokens, seller, mpp, ready: () => { ready = true; }, get buyer() { return buyer; }, get store() { return store; },
    restart() { store.close(); store = new BuyerStore(join(directory, 'buyer.sqlite3')); buyer = new CommerceBuyer({ ...buyerOptions, store }); },
    close: async () => { await buyer.stop(); seller.stop(); while (seller.isRunning) await new Promise(r => setTimeout(r, 1)); store.close(); sellerStore.close(); rmSync(directory, { recursive: true, force: true }); } };
}
async function finish(f, purchase) { while (f.seller.isRunning) await new Promise(r => setTimeout(r, 1)); return f.buyer.recover('owner', purchase.id); }

test('native official MPP SDK uses original SPT, separate Bearer identity and independently verified receipt', async () => {
  const f = fixture(); try {
    const preview = await f.buyer.preview('owner', input()); assert.equal(preview.quote.amount, '300'); assert.equal(preview.payer, 'buyer_test'); assert.equal(f.calls.createToken.length, 0);
    const done = await finish(f, await confirm(f.buyer, preview));
    assert.equal(done.paymentState, 'confirmed'); assert.equal(done.executionState, 'completed'); assert.equal(f.calls.createToken.length, 1); assert.equal(f.calls.create.length, 1);
    assert.deepEqual(f.calls.bearer, ['Bearer ' + token]);
    const credential = Credential.deserialize(f.calls.credentials[0]); assert.equal(credential.challenge.header, 'Payment-Authorization'); assert.equal(credential.payload.spt, 'spt_test_1');
    const operation = f.calls.createToken[0]; assert.equal(operation.amount, '300'); assert.equal(operation.currency, 'usd'); assert.equal(operation.networkId, 'profile_test'); assert.equal(operation.purchaseId, preview.id); assert.equal(operation.idempotencyKey, operation.operationId);
    assert.deepEqual(f.store.usage('usd'), { reserved: '0', spent: '300' }); assert.equal(JSON.stringify(done).includes('spt_'), false);
  } finally { await f.close(); }
});

test('lost token creation retains original operation and USD reservation across restart', async () => {
  const f = fixture({ loseToken: true }); try {
    const preview = await f.buyer.preview('owner', input()); const unknown = await confirm(f.buyer, preview);
    assert.equal(unknown.paymentState, 'unknown'); assert.equal(f.calls.createToken.length, 1); assert.equal(f.calls.create.length, 0);
    assert.deepEqual(f.store.usage('usd'), { reserved: '300', spent: '0' });
    f.restart(); const done = await finish(f, await f.buyer.recover('owner', unknown.id));
    assert.equal(done.paymentState, 'confirmed'); assert.equal(f.calls.createToken.length, 1); assert.equal(f.calls.recoverToken.length, 1);
    assert.equal(f.calls.recoverToken[0].operationId, f.calls.createToken[0].operationId);
  } finally { await f.close(); }
});

test('lost paid response replays byte-identical original credential without new SPT or charge', async () => {
  const f = fixture({ loseResponse: true }); try {
    const preview = await f.buyer.preview('owner', input()); const unknown = await confirm(f.buyer, preview); assert.equal(unknown.state, 'unknown');
    f.restart(); const done = await finish(f, await f.buyer.recover('owner', unknown.id)); assert.equal(done.paymentState, 'confirmed');
    assert.equal(f.calls.createToken.length, 1); assert.equal(f.calls.create.length, 1); assert.equal(f.calls.credentials[0], f.calls.credentials[1]); assert.equal(f.calls.paidBodies[0], f.calls.paidBodies[1]);
  } finally { await f.close(); }
});

test('USD budget reservations serialize concurrent purchases', async () => {
  const limited = structuredClone(policy); limited.budgets[0].maxTotal = '300';
  const f = fixture({ policy: limited }); try {
    const previews = await Promise.all([f.buyer.preview('owner', input('one')), f.buyer.preview('owner', input('two'))]);
    const results = await Promise.allSettled(previews.map(p => confirm(f.buyer, p)));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(results.find(r => r.status === 'rejected').reason.code, 'budget_exceeded'); assert.equal(f.calls.createToken.length, 1);
  } finally { await f.close(); }
});

test('forged native amount, merchant and identity header are rejected before SPT creation', async () => {
  for (const field of ['amount', 'merchant', 'header']) {
    const f = fixture({ mutateChallenge: challenge => { if (field === 'amount') challenge.request.amount = '1'; if (field === 'merchant') challenge.request.methodDetails.networkId = 'profile_evil'; if (field === 'header') challenge.header = 'Authorization'; } });
    try { await assert.rejects(f.buyer.preview('owner', input()), { code: 'quote_mismatch' }); assert.equal(f.calls.createToken.length, 0); assert.equal(f.calls.create.length, 0); }
    finally { await f.close(); }
  }
});

test('server receipt alone cannot mark USD spent; caller cannot inspect another original SPT operation', async () => {
  const f = fixture({ receiptReady: false }); try {
    const preview = await f.buyer.preview('owner', input());
    await assert.rejects(confirm(f.buyer, preview, 'foreign'), { code: 'purchase_not_found' });
    const pending = await confirm(f.buyer, preview); assert.equal(pending.paymentState, 'unknown'); assert.deepEqual(f.store.usage('usd'), { reserved: '300', spent: '0' });
    assert.throws(() => f.buyer.get('foreign', pending.id), { code: 'purchase_not_found' });
    f.ready(); const done = await finish(f, pending); assert.equal(done.paymentState, 'confirmed'); assert.equal(f.calls.createToken.length, 1);
  } finally { await f.close(); }
});

test('token recovery has the original payment method and never creates another SPT when absent', async () => {
  const f = fixture({ loseToken: true }); try {
    const preview = await f.buyer.preview('owner', input()); const unknown = await confirm(f.buyer, preview);
    f.mpp.paymentMethod = 'pm_changed'; f.tokens.clear(); f.restart();
    const pending = await f.buyer.recover('owner', unknown.id); assert.equal(pending.paymentState, 'unknown'); assert.equal(f.calls.createToken.length, 1); assert.equal(f.calls.create.length, 0);
    assert.equal(f.calls.recoverToken[0].paymentMethod, 'pm_authorized'); assert.equal(f.calls.recoverToken[0].operationId, f.calls.createToken[0].operationId);
    assert.deepEqual(f.store.usage('usd'), { reserved: '300', spent: '0' });
  } finally { await f.close(); }
});

test('authentication sanitizes provider output, validates mode and never persists customer action', async () => {
  const f = fixture({ loseToken: true });
  try {
    const preview = await f.buyer.preview('owner', input()), unknown = await confirm(f.buyer, preview);
    const before = JSON.stringify(f.buyer.get('owner', unknown.id));
    await assert.rejects(f.buyer.authentication('owner', unknown.id), { code: 'mpp_authentication_unavailable' });
    let observed;
    const action = { type: 'use_stripe_sdk', hashedValue: 'private-action', publishableKey: 'pk_test_issuer', secretKey: 'sk_test_doNotExpose' };
    f.mpp.getAuthentication = async context => { observed = context; return action; };
    const result = await f.buyer.authentication('owner', unknown.id);
    assert.deepEqual(result, { purchaseId: unknown.id, action: { type: 'use_stripe_sdk', hashedValue: 'private-action', publishableKey: 'pk_test_issuer' } });
    assert.equal(observed.purchaseId, unknown.id); assert.equal(observed.operationId, f.calls.createToken[0].operationId);
    assert.deepEqual(observed.quote, unknown.quote); assert.equal(observed.mode, 'test');
    for (const patch of [{ type: 'redirect_to_url' }, { publishableKey: 'pk_live_wrong' }, { hashedValue: '' }, { hashedValue: 'x'.repeat(16385) }]) {
      f.mpp.getAuthentication = async () => ({ ...action, ...patch });
      await assert.rejects(f.buyer.authentication('owner', unknown.id), { code: 'stripe_spt_action_unsupported' });
    }
    assert.equal(JSON.stringify(f.buyer.get('owner', unknown.id)), before);
    assert.deepEqual(f.store.usage('usd'), { reserved: '300', spent: '0' });
    assert.equal(f.calls.createToken.length, 1); assert.equal(f.calls.create.length, 0); assert.equal(f.calls.recoverToken.length, 0);
  } finally { await f.close(); }
});
