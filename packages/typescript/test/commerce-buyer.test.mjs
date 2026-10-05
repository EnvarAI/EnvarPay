import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Task } from '@a2a-js/sdk';
import { decodePaymentRequiredHeader, decodePaymentSignatureHeader, encodePaymentRequiredHeader } from '@x402/core/http';
import { CommerceBuyer } from '../dist/commerce/buyer.js';
import { BuyerStore } from '../dist/commerce/buyer-store.js';
import { CredentialVault } from '../dist/commerce/vault.js';
import { CommerceStore, CommerceServer, bearerAuthenticator } from '../dist/commerce/runtime.js';
import { X402Gate } from '../dist/commerce/x402.js';
import { loadCommerceConfig } from '../dist/commerce/config.js';

const payer = '0x' + '1'.repeat(40), payee = '0x' + '2'.repeat(40), token = 'a'.repeat(40);
const origin = 'https://seller.example', cardUrl = origin + '/services/research/v1/offers/usdc-once/agent-card.json';
const currency = 'eip155:84532/erc20:0x036cbd53842c5426634e7929541ec2318f3dcf7e';
const policy = { policyVersion: 1, paymentsEnabled: true, approval: 'per_purchase', peers: [{ id: 'seller', cardUrl, protocol: 'x402', currency, recipient: payee, maxPerPurchase: '3000000' }], budgets: [{ currency, maxTotal: '6000000', period: 'cumulative' }] };

function fixture(options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'envar-buyer-'));
  const sellerStore = new CommerceStore(':memory:');
  const sellerVault = new CredentialVault(join(directory, 'seller-vault'), Buffer.alloc(32, 3));
  let store = new BuyerStore(join(directory, 'buyer.sqlite3'));
  const vault = new CredentialVault(join(directory, 'buyer-vault'), Buffer.alloc(32, 4));
  const calls = { sign: 0, settle: 0, execute: 0, reads: 0, paidBodies: [], paidHeaders: [], signedNonces: [] };
  const facilitator = {
    getSupported: async () => ({ kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:84532' }], extensions: [], signers: {} }),
    verify: async () => ({ isValid: true, payer }),
    settle: async () => { calls.settle++; return { success: true, payer, network: 'eip155:84532', transaction: '0x' + '5'.repeat(64) }; },
  };
  const gate = new X402Gate({ store: sellerStore, vault: sellerVault, payerFor: () => payer, facilitator: () => facilitator, verifyReceipt: async () => true });
  const config = loadCommerceConfig(JSON.parse(readFileSync(new URL('../examples/seller.json', import.meta.url), 'utf8')));
  if (options.clarification) config.services[0].contract.inputSchema.properties.clarification = { type: 'string' };
  const seller = new CommerceServer({ config, store: sellerStore, origin, authenticate: bearerAuthenticator({ [token]: 'buyer' }), paymentGate: gate,
    execute: async function* (order) { calls.execute++; yield Task.fromJSON({ id: 'remote-' + order.id, status: { state: options.waiting ? 'TASK_STATE_INPUT_REQUIRED' : 'TASK_STATE_COMPLETED' }, artifacts: [{ artifactId: 'result', parts: [{ text: 'fixture delivery' }] }] }); } });
  let loseNextPaid = Boolean(options.loseResponse), receiptReady = options.receiptReady ?? true;
  const fetchImpl = async (input, init) => {
    const request = new Request(input, init); calls.reads++;
    if (options.fetchOverride) { const response = await options.fetchOverride(request); if (response) return response; }
    if (request.headers.has('PAYMENT-SIGNATURE')) {
      if (options.dropBeforeSeller) throw new Error('network unavailable before seller');
      calls.paidBodies.push(await request.clone().text()); calls.paidHeaders.push(request.headers.get('PAYMENT-SIGNATURE'));
      const result = await seller.handle(request);
      if (options.malformedPaidBody) return new Response('malformed', { status: result.status, headers: result.headers });
      if (loseNextPaid) { loseNextPaid = false; throw new Error('response lost'); }
      return result;
    }
    return seller.handle(request);
  };
  const signer = { address: payer, signTypedData: async value => { calls.sign++; calls.signedNonces.push(value.message.nonce); options.onSign?.(store, value); if (options.signWait) await options.signWait(); return '0x' + '6'.repeat(130); } };
  const buyerOptions = { policy: options.policy ?? policy, store, vault, signer, peerTokens: { seller: token }, fetchImpl, verifyReceipt: async (receipt, payload, requirements) => options.verifyReceipt ? options.verifyReceipt(receipt, payload, requirements) : receiptReady, checkpoint: options.checkpoint ?? (async () => '100'), findOriginalReceipt: options.findOriginalReceipt, proveExpiredUnused: options.proveExpiredUnused };
  let buyer = new CommerceBuyer(buyerOptions);
  return {
    directory, calls, seller, sellerStore, vault,
    get buyer() { return buyer; }, get store() { return store; },
    ready: () => { receiptReady = true; },
    restart() { store.close(); store = new BuyerStore(join(directory, 'buyer.sqlite3')); buyer = new CommerceBuyer({ ...buyerOptions, store }); },
    close: async () => { await buyer.stop(); seller.stop(); while (seller.isRunning) await new Promise(r => setTimeout(r, 1)); store.close(); sellerStore.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}
const input = (messageId = 'buy-1') => ({ cardUrl, messageId, offerId: 'usdc-once', input: { topic: 'x', competitors: ['A'] } });
const confirm = (buyer, preview, caller = 'owner') => buyer.confirm(caller, { previewId: preview.id, quoteToken: preview.quoteToken, messageId: preview.messageId });

async function finish(f, purchase) {
  while (f.seller.isRunning) await new Promise(r => setTimeout(r, 1));
  return f.buyer.recover('owner', purchase.id);
}

test('official A2A/x402 preview, durable approval, receipt and Task recovery', async () => {
  const f = fixture(); try {
    const preview = await f.buyer.preview('owner', input());
    assert.equal(preview.quote.amount, '3000000'); assert.equal(preview.quote.payer, payer); assert.equal(preview.quote.messageId, 'buy-1');
    assert.equal(f.calls.sign, 0); assert.equal(f.calls.execute, 0);
    const purchased = await confirm(f.buyer, preview);
    const done = await finish(f, purchased);
    assert.equal(done.paymentState, 'confirmed'); assert.equal(done.executionState, 'completed');
    assert.equal(f.calls.sign, 1); assert.equal(f.calls.settle, 1); assert.equal(f.calls.execute, 1);
    assert.deepEqual(f.store.usage(currency), { reserved: '0', spent: '3000000' });
    const again = await confirm(f.buyer, preview); assert.equal(again.id, done.id); assert.equal(f.calls.sign, 1);
    assert.equal(JSON.stringify(done).includes('signature'), false); assert.equal(JSON.stringify(done).includes(token), false);
  } finally { await f.close(); }
});

test('concurrent cumulative reservations prevent a second authorization over budget', async () => {
  const reduced = structuredClone(policy); reduced.budgets[0].maxTotal = '3000000';
  const f = fixture({ policy: reduced }); try {
    const previews = await Promise.all([f.buyer.preview('owner', input('one')), f.buyer.preview('owner', input('two'))]);
    const results = await Promise.allSettled(previews.map(p => confirm(f.buyer, p)));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(results.find(r => r.status === 'rejected').reason.code, 'budget_exceeded');
    assert.equal(f.calls.sign, 1); assert.equal(f.calls.settle, 1);
  } finally { await f.close(); }
});

test('100 distinct concurrent purchases retain exact reservations and original authorizations across restart within one budget', { timeout: 30000 }, async () => {
  const boundedPolicy = structuredClone(policy), price = 3000000n, allowed = 13, cap = price * BigInt(allowed);
  boundedPolicy.budgets[0].maxTotal = cap.toString();
  let releaseSigners, atBarrier, signerCount = 0;
  const barrier = new Promise(resolve => { releaseSigners = resolve; }), allReserved = new Promise(resolve => { atBarrier = resolve; });
  const verifiedNonces = new Set(), samples = [];
  const f = fixture({ policy: boundedPolicy, signWait: () => barrier,
    onSign: store => {
      const usage = store.usage(currency), total = BigInt(usage.reserved) + BigInt(usage.spent);
      samples.push(total); assert.ok(total <= cap); if (++signerCount === allowed) atBarrier();
    },
    verifyReceipt: async (_receipt, payload) => verifiedNonces.has(payload.payload.authorization.nonce),
  });
  try {
    const previews = await Promise.all(Array.from({ length: 100 }, (_, index) => f.buyer.preview('owner', input('distinct-' + index))));
    assert.equal(new Set(previews.map(p => p.id)).size, 100); assert.equal(new Set(previews.map(p => p.messageId)).size, 100);
    let rejectedBeforeIssue = 0;
    const attempts = previews.map(p => confirm(f.buyer, p).catch(error => { assert.equal(error.code, 'budget_exceeded'); rejectedBeforeIssue++; throw error; }));
    const pending = Promise.allSettled(attempts);
    await allReserved;
    assert.deepEqual(f.store.usage(currency), { reserved: cap.toString(), spent: '0' });
    assert.equal(f.calls.sign, allowed); assert.equal(f.calls.settle, 0); assert.equal(f.calls.execute, 0);
    assert.equal(new Set(f.calls.signedNonces).size, allowed);
    // Seven receipts are independently accepted; the remaining six stay unknown/reserved.
    f.calls.signedNonces.slice(0, 7).forEach(nonce => verifiedNonces.add(nonce));
    releaseSigners();
    const results = await pending;
    while (f.seller.isRunning) await new Promise(resolve => setTimeout(resolve, 1));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, allowed); assert.equal(rejectedBeforeIssue, 87);
    const winners = previews.filter((_p, i) => results[i].status === 'fulfilled'), losers = previews.filter((_p, i) => results[i].status === 'rejected');
    const saved = winners.map(p => f.store.get(p.id, 'owner'));
    assert.equal(saved.filter(p => p.paymentState === 'confirmed').length, 7); assert.equal(saved.filter(p => p.paymentState === 'unknown').length, 6);
    for (const p of losers) { const r = f.store.get(p.id, 'owner'); assert.equal(r.state, 'previewed'); assert.equal(r.paymentState, 'quoted'); assert.equal(r.credentialRef, undefined); assert.equal(r.nonce, undefined); }
    const usage = { reserved: (price * 6n).toString(), spent: (price * 7n).toString() };
    assert.deepEqual(f.store.usage(currency), usage); assert.ok(samples.every(amount => amount <= cap));
    assert.equal(f.calls.sign, allowed); assert.equal(f.calls.settle, allowed); assert.equal(f.calls.execute, allowed);
    assert.equal(new Set(saved.map(r => r.nonce)).size, allowed);
    assert.deepEqual(new Set(f.calls.paidHeaders.map(h => decodePaymentSignatureHeader(h).payload.authorization.nonce)), new Set(saved.map(r => r.nonce)));
    const originals = saved.map(r => ({ id: r.id, nonce: r.nonce, credentialRef: r.credentialRef, taskId: r.task.id, paymentState: r.paymentState }));
    await f.buyer.stop(); f.restart();
    for (const before of originals) { const after = f.store.get(before.id, 'owner'); for (const key of ['nonce', 'credentialRef', 'paymentState']) assert.equal(after[key], before[key]); assert.equal(after.task.id, before.taskId); }
    assert.deepEqual(f.store.usage(currency), usage);
    const paidCount = f.calls.paidHeaders.length;
    await Promise.all(winners.map(p => f.buyer.recover('owner', p.id)));
    await Promise.all(losers.map(p => assert.rejects(confirm(f.buyer, p), { code: 'budget_exceeded' })));
    assert.deepEqual(f.store.usage(currency), usage); assert.equal(f.calls.sign, allowed); assert.equal(f.calls.settle, allowed); assert.equal(f.calls.paidHeaders.length, paidCount);
  } finally { releaseSigners(); await f.close(); }
});

test('independent purchase and original recovery use only approved peer transport while every Envar domain is denied', async () => {
  const originalFetch = globalThis.fetch, denied = [], peerCalls = [];
  globalThis.fetch = async input => { denied.push(String(input?.url ?? input)); throw new Error('All ambient network access denied, including Envar'); };
  const f = fixture({ fetchOverride: async request => {
    const hostname = new URL(request.url).hostname;
    if (hostname === 'envar.ai' || hostname.endsWith('.envar.ai') || hostname.includes('envar')) throw new Error('Envar domain forbidden');
    assert.equal(hostname, 'seller.example'); peerCalls.push(request.method);
  } });
  try {
    const preview = await f.buyer.preview('owner', input('no-platform'));
    const done = await finish(f, await confirm(f.buyer, preview));
    assert.equal(done.paymentState, 'confirmed'); assert.equal(done.executionState, 'completed');
    await f.buyer.stop(); f.restart();
    const restored = await f.buyer.recover('owner', done.id);
    assert.equal(restored.id, done.id); assert.equal(restored.task.id, done.task.id); assert.equal(restored.nonce, done.nonce);
    assert.equal(f.calls.sign, 1); assert.equal(f.calls.settle, 1); assert.equal(f.calls.execute, 1); assert.deepEqual(denied, []); assert.ok(peerCalls.length > 0);
  } finally { await f.close(); globalThis.fetch = originalFetch; }
});

test('lost paid response and restart replay identical bytes and authorization, never sign or pay again', async () => {
  const f = fixture({ loseResponse: true }); try {
    const preview = await f.buyer.preview('owner', input());
    const lost = await confirm(f.buyer, preview); assert.equal(lost.state, 'unknown');
    assert.deepEqual(f.store.usage(currency), { reserved: '3000000', spent: '0' });
    f.restart();
    const recovered = await finish(f, await f.buyer.recover('owner', lost.id));
    assert.equal(recovered.paymentState, 'confirmed'); assert.equal(recovered.executionState, 'completed');
    assert.equal(f.calls.sign, 1); assert.equal(f.calls.settle, 1);
    assert.equal(f.calls.paidBodies.length, 2); assert.equal(f.calls.paidBodies[0], f.calls.paidBodies[1]); assert.equal(f.calls.paidHeaders[0], f.calls.paidHeaders[1]);
  } finally { await f.close(); }
});

test('unverified receipts reserve budget until independent chain verification succeeds', async () => {
  const f = fixture({ receiptReady: false }); try {
    const preview = await f.buyer.preview('owner', input());
    const pending = await confirm(f.buyer, preview); assert.equal(pending.paymentState, 'unknown');
    assert.deepEqual(f.store.usage(currency), { reserved: '3000000', spent: '0' });
    f.ready(); const done = await finish(f, pending);
    assert.equal(done.paymentState, 'confirmed'); assert.deepEqual(f.store.usage(currency), { reserved: '0', spent: '3000000' });
    assert.equal(f.calls.sign, 1);
  } finally { await f.close(); }
});

test('caller ownership, immutable message IDs and quote tokens are enforced before signing', async () => {
  const f = fixture(); try {
    const preview = await f.buyer.preview('owner', input());
    await assert.rejects(confirm(f.buyer, preview, 'stranger'), { code: 'purchase_not_found' });
    assert.throws(() => f.buyer.get('stranger', preview.id), { code: 'purchase_not_found' });
    await assert.rejects(f.buyer.recover('stranger', preview.id), { code: 'purchase_not_found' });
    await assert.rejects(f.buyer.confirm('owner', { previewId: preview.id, quoteToken: 'wrong', messageId: preview.messageId }), { code: 'approval_mismatch' });
    await assert.rejects(f.buyer.preview('owner', { ...input(), input: { topic: 'changed', competitors: ['A'] } }), { code: 'purchase_conflict' });
    const concurrent = await Promise.all(Array.from({ length: 8 }, () => confirm(f.buyer, preview)));
    assert.equal(concurrent.every(p => p.id === preview.id), true); assert.equal(f.calls.sign, 1);
  } finally { await f.close(); }
});

test('local policy stays disabled and disallows foreign Card URLs without network access', async () => {
  const disabled = structuredClone(policy); disabled.paymentsEnabled = false;
  const f = fixture({ policy: disabled }); try {
    await assert.rejects(f.buyer.preview('owner', { ...input(), cardUrl: 'https://other.example/agent-card.json' }), { code: 'peer_not_allowed' }); assert.equal(f.calls.reads, 0);
    const preview = await f.buyer.preview('owner', input()); await assert.rejects(confirm(f.buyer, preview), { code: 'payments_disabled' }); assert.equal(f.calls.sign, 0);
  } finally { await f.close(); }
});

test('second process owner lock and interrupted signing cannot create a replacement nonce', async () => {
  const f = fixture(); try {
    assert.throws(() => new BuyerStore(join(f.directory, 'buyer.sqlite3')), { code: 'store_locked' });
    const preview = await f.buyer.preview('owner', input()); f.store.reserve(preview.id, 'owner', policy);
    f.restart(); const recovered = await f.buyer.recover('owner', preview.id);
    assert.equal(recovered.state, 'unknown'); assert.equal(recovered.errorCode, 'authorization_recovery_required'); assert.equal(f.calls.sign, 0);
    assert.deepEqual(f.store.usage(currency), { reserved: '3000000', spent: '0' });
  } finally { await f.close(); }
});

test('Card endpoint changes and redirects never forward peer credentials', async () => {
  for (const kind of ['redirect', 'foreign-endpoint', 'free']) {
    const f = fixture({ fetchOverride: async request => {
      if (!request.url.endsWith('agent-card.json')) return;
      if (kind === 'redirect') return new Response(null, { status: 302, headers: { Location: 'https://evil.example' } });
      const response = await f.seller.handle(request), body = await response.json();
      if (kind === 'foreign-endpoint') body.supportedInterfaces[0].url = 'https://evil.example/a2a';
      else body.capabilities.extensions[0].params.pricing = { kind: 'free' };
      return Response.json(body);
    } });
    try { await assert.rejects(f.buyer.preview('owner', input())); assert.equal(f.calls.sign, 0); assert.equal(f.calls.execute, 0); assert.equal(f.calls.reads, 1); }
    finally { await f.close(); }
  }
});

test('different local callers cannot purchase the same remote message with separate authorizations', async () => {
  const f = fixture(); try {
    const results = await Promise.allSettled([f.buyer.preview('owner', input()), f.buyer.preview('other-owner', input())]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(results.find(r => r.status === 'rejected').reason.code, 'purchase_conflict');
    assert.equal(f.calls.sign, 0);
  } finally { await f.close(); }
});

test('budget accounting remains exact above the Number safe integer boundary', async () => {
  const f = fixture(); try {
    const preview = await f.buyer.preview('owner', input());
    const saved = f.store.get(preview.id, 'owner');
    const amount = '9007199254740993';
    const large = f.store.insert({ ...saved, caller: 'large', messageId: 'large-one', fingerprint: 'one', quote: { ...saved.quote, amount } });
    const next = f.store.insert({ ...saved, caller: 'large', messageId: 'large-two', fingerprint: 'two', quote: { ...saved.quote, amount: '1' } });
    const largePolicy = { ...policy, budgets: [{ currency, maxTotal: amount, period: 'cumulative' }] };
    f.store.reserve(large.id, 'large', largePolicy);
    assert.deepEqual(f.store.usage(currency), { reserved: amount, spent: '0' });
    assert.throws(() => f.store.reserve(next.id, 'large', largePolicy), { code: 'budget_exceeded' });
  } finally { await f.close(); }
});

test('background observer advances saved Tasks using only GetTask and resumes after restart', async () => {
  const f = fixture(); try {
    const preview = await f.buyer.preview('owner', input()); const purchased = await confirm(f.buyer, preview);
    while (f.seller.isRunning) await new Promise(r => setTimeout(r, 1));
    f.store.update(purchased.id, { state: 'submitted', executionState: 'working' });
    f.restart(); const paidBefore = f.calls.paidBodies.length;
    f.buyer.start(100);
    for (let i = 0; i < 30 && f.buyer.get('owner', purchased.id).executionState !== 'completed'; i++) await new Promise(r => setTimeout(r, 50));
    assert.equal(f.buyer.get('owner', purchased.id).executionState, 'completed');
    assert.equal(f.calls.sign, 1); assert.equal(f.calls.paidBodies.length, paidBefore);
    await f.buyer.stop();
  } finally { await f.close(); }
});

test('continuation keeps the original Task and budget, adds only schema-valid fields and deduplicates', async () => {
  let rounds = 0;
  const f = fixture({ waiting: true, clarification: true, fetchOverride: async request => {
    if (request.method !== 'POST') return;
    const body = await request.clone().json(); if (!body.params?.message?.taskId) return;
    rounds++; assert.equal(request.headers.has('PAYMENT-SIGNATURE'), false);
    return Response.json({ jsonrpc: '2.0', id: body.id, result: { task: { id: body.params.message.taskId, status: { state: 'TASK_STATE_COMPLETED' }, history: [body.params.message] } } });
  } }); try {
    const preview = await f.buyer.preview('owner', input()); const purchased = await finish(f, await confirm(f.buyer, preview));
    assert.equal(purchased.executionState, 'input_required');
    await assert.rejects(f.buyer.continue('stranger', purchased.id, { messageId: 'round', input: input().input }), { code: 'purchase_not_found' });
    await assert.rejects(f.buyer.continue('owner', purchased.id, { messageId: 'round', input: { topic: 'changed', competitors: ['A'] } }), { code: 'continuation_scope' });
    await assert.rejects(f.buyer.continue('owner', purchased.id, { messageId: 'round', input: { ...input().input, forbidden: true } }), { code: 'invalid_input' });
    const followup = { messageId: 'round', input: { ...input().input, clarification: 'Focus on reliability.' } };
    const result = await f.buyer.continue('owner', purchased.id, followup); assert.equal(result.executionState, 'completed');
    assert.equal(result.task.id, purchased.task.id); assert.equal(f.calls.sign, 1); assert.equal(f.calls.settle, 1);
    assert.deepEqual(f.store.usage(currency), { reserved: '0', spent: '3000000' });
    await f.buyer.continue('owner', purchased.id, followup); assert.equal(rounds, 1);
  } finally { await f.close(); }
});

test('lost continuation cannot create a new round until original message is observed in Task history', async () => {
  let rounds = 0, readUpdated = false, originalTask;
  const f = fixture({ waiting: true, clarification: true, fetchOverride: async request => {
    if (request.method !== 'POST') return;
    const body = await request.clone().json();
    if (body.params?.message?.taskId) { rounds++; originalTask = { id: body.params.message.taskId, status: { state: 'TASK_STATE_INPUT_REQUIRED' }, history: [body.params.message] }; throw new Error('response lost'); }
    if (readUpdated && body.method === 'GetTask') return Response.json({ jsonrpc: '2.0', id: body.id, result: originalTask });
  } }); try {
    const preview = await f.buyer.preview('owner', input()); const purchased = await finish(f, await confirm(f.buyer, preview));
    const followup = { messageId: 'round-one', input: { ...input().input, clarification: 'x' } };
    const unknown = await f.buyer.continue('owner', purchased.id, followup); assert.equal(unknown.state, 'unknown');
    await assert.rejects(f.buyer.continue('owner', purchased.id, { ...followup, messageId: 'round-two' }), { code: 'continuation_unknown' });
    await f.buyer.recover('owner', purchased.id);
    await assert.rejects(f.buyer.continue('owner', purchased.id, { ...followup, messageId: 'round-two' }), { code: 'continuation_unknown' });
    readUpdated = true; await f.buyer.recover('owner', purchased.id);
    assert.equal(f.store.get(purchased.id, 'owner').continuations[0].state, 'resolved');
    assert.equal(rounds, 1); assert.equal(f.calls.sign, 1);
  } finally { await f.close(); }
});

test('native challenge recipient, resource and quote digests cannot bypass advertised terms', async () => {
  for (const change of ['recipient', 'resource', 'digest']) {
    const f = fixture({ fetchOverride: async request => {
      if (request.method !== 'POST') return;
      const response = await f.seller.handle(request);
      const required = decodePaymentRequiredHeader(response.headers.get('PAYMENT-REQUIRED'));
      if (change === 'recipient') required.accepts[0].payTo = '0x' + '3'.repeat(40);
      if (change === 'resource') required.resource.url = 'https://evil.example/a2a?quote=wrong';
      if (change === 'digest') required.extensions['urn:envarpay:quote:1'].info.inputDigest = '0'.repeat(64);
      return new Response('{}', { status: 402, headers: { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader(required) } });
    } });
    try { await assert.rejects(f.buyer.preview('owner', input()), { code: 'quote_mismatch' }); assert.equal(f.calls.sign, 0); assert.equal(f.calls.settle, 0); }
    finally { await f.close(); }
  }
});

test('a lower local policy after preview blocks confirmation before budget reservation', async () => {
  const f = fixture(); try {
    const preview = await f.buyer.preview('owner', input());
    f.buyer.policy.peers[0].maxPerPurchase = '1';
    await assert.rejects(confirm(f.buyer, preview), { code: 'policy_changed' });
    assert.equal(f.calls.sign, 0); assert.deepEqual(f.store.usage(currency), { reserved: '0', spent: '0' });
  } finally { await f.close(); }
});

test('malformed Task response cannot downgrade independently confirmed payment', async () => {
  const f = fixture({ malformedPaidBody: true }); try {
    const preview = await f.buyer.preview('owner', input()); const result = await confirm(f.buyer, preview);
    assert.equal(result.state, 'unknown'); assert.equal(result.paymentState, 'confirmed');
    assert.deepEqual(f.store.usage(currency), { reserved: '0', spent: '3000000' });
    assert.equal(f.calls.sign, 1); assert.equal(f.calls.settle, 1);
  } finally { await f.close(); }
});

test('failed pre-sign checkpoint safely releases budget without inventing an authorization', async () => {
  const f = fixture({ checkpoint: async () => { throw new Error('RPC offline'); } }); try {
    const preview = await f.buyer.preview('owner', input()); const result = await confirm(f.buyer, preview);
    assert.equal(result.state, 'failed'); assert.equal(result.paymentState, 'rejected'); assert.equal(f.calls.sign, 0);
    assert.deepEqual(f.store.usage(currency), { reserved: '0', spent: '0' });
    const recovered = await f.buyer.recover('owner', result.id); assert.equal(recovered.paymentState, 'rejected'); assert.equal(f.calls.sign, 0);
  } finally { await f.close(); }
});

test('quote expiry during checkpoint releases only the definitely unsigned reservation', async () => {
  let originalNow;
  const f = fixture({ checkpoint: async () => { originalNow = Date.now; Date.now = () => originalNow() + 3600001; return '100'; } }); try {
    const preview = await f.buyer.preview('owner', input()); const result = await confirm(f.buyer, preview);
    assert.equal(result.errorCode, 'quote_expired'); assert.equal(result.paymentState, 'rejected'); assert.equal(f.calls.sign, 0);
    assert.deepEqual(f.store.usage(currency), { reserved: '0', spent: '0' });
  } finally { if (originalNow) Date.now = originalNow; await f.close(); }
});

test('signer failure after invocation retains unknown reservation and never signs again', async () => {
  const f = fixture({ signWait: async () => { throw new Error('hardware response lost'); } }); try {
    const preview = await f.buyer.preview('owner', input()); const result = await confirm(f.buyer, preview);
    assert.equal(result.state, 'unknown'); assert.equal(result.paymentState, 'unknown'); assert.equal(f.calls.sign, 1);
    assert.deepEqual(f.store.usage(currency), { reserved: '3000000', spent: '0' });
    await f.buyer.recover('owner', result.id); assert.equal(f.calls.sign, 1);
  } finally { await f.close(); }
});

test('finalized expired-unused proof releases only original unconfirmed authorization', async () => {
  for (const proven of [false, true]) {
    const f = fixture({ dropBeforeSeller: true, proveExpiredUnused: async () => proven }); try {
      const preview = await f.buyer.preview('owner', input()); const unknown = await confirm(f.buyer, preview);
      const original = f.store.get(unknown.id, 'owner');
      const recovered = await f.buyer.recover('owner', unknown.id);
      if (proven) {
        assert.equal(recovered.paymentState, 'rejected'); assert.equal(recovered.errorCode, 'authorization_expired_unused');
        assert.deepEqual(f.store.usage(currency), { reserved: '0', spent: '0' });
        const saved = f.store.get(unknown.id, 'owner'); assert.equal(saved.nonce, original.nonce); assert.equal(saved.credentialRef, original.credentialRef); assert.equal(saved.rejectionEvidence.nonce, original.nonce);
      } else {
        assert.equal(recovered.paymentState, 'unknown');
        assert.deepEqual(f.store.usage(currency), { reserved: '3000000', spent: '0' });
      }
      assert.equal(f.calls.sign, 1); assert.equal(f.calls.settle, 0);
    } finally { await f.close(); }
  }
});

test('expired-unused callback never downgrades an independently confirmed payment', async () => {
  let checks = 0;
  const f = fixture({ proveExpiredUnused: async () => { checks++; return true; } }); try {
    const preview = await f.buyer.preview('owner', input()); const confirmed = await confirm(f.buyer, preview);
    await f.buyer.recover('owner', confirmed.id); assert.equal(checks, 0);
    assert.equal(f.store.rejectExpiredAuthorization(confirmed.id, 'owner').paymentState, 'confirmed');
    assert.deepEqual(f.store.usage(currency), { reserved: '0', spent: '3000000' });
  } finally { await f.close(); }
});
