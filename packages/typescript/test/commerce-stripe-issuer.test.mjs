import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Challenge } from 'mppx';
import { Task } from '@a2a-js/sdk';
import { createStripeMppBuyer, STRIPE_ISSUER_API_VERSION } from '../dist/commerce/mpp-runtime.js';
import { CredentialVault } from '../dist/commerce/vault.js';
import { CommerceBuyer } from '../dist/commerce/buyer.js';
import { BuyerStore } from '../dist/commerce/buyer-store.js';
import { CommerceStore, CommerceServer, bearerAuthenticator } from '../dist/commerce/runtime.js';
import { MppGate } from '../dist/commerce/mpp.js';
import { loadCommerceConfig } from '../dist/commerce/config.js';

const purchaseId = '6a013de9-935b-419b-8b2a-3b1f2e49c6f7';
const sellerOrder = '9ca0d568-1dfd-4304-bab4-c41c40e29038';
const profile = 'profile_test_owned';
const config = () => ({ payer: 'buyer-owned', mode: 'test', issuerAccountId: 'acct_issuer', secretKey: 'sk_test_issuer', paymentMethod: 'pm_authorized',
  sellers: { [profile]: { accountId: 'acct_seller', secretKey: 'rk_test_seller' } }, returnUrl: 'https://buyer.example/stripe-return' });
function operation(at = Date.now(), settings = config()) {
  const merchant = Object.keys(settings.sellers)[0];
  const expiresAt = new Date(at + 300000).toISOString();
  const quote = { messageId: 'message-1', payer: settings.payer, amount: '300', currency: 'usd', recipient: merchant,
    expiresAt, serviceId: 'research', serviceRevision: 1, offerId: 'card-once', inputDigest: 'input-digest', termsDigest: 'terms-digest', quoteId: 'quote-original' };
  const metadata = { envarpay_order: sellerOrder, envarpay_quote: quote.quoteId, envarpay_terms: quote.termsDigest };
  const challenge = Challenge.from({ id: 'original-challenge', realm: 'seller.example', method: 'stripe', intent: 'charge', header: 'Payment-Authorization', expires: expiresAt,
    request: { amount: quote.amount, currency: 'usd', recipient: merchant, externalId: quote.quoteId, methodDetails: { networkId: merchant, paymentMethodTypes: ['card'], metadata } } });
  return { operationId: 'mpp-token-' + purchaseId, idempotencyKey: 'mpp-token-' + purchaseId, purchaseId, quote, mode: settings.mode,
    amount: quote.amount, currency: 'usd', networkId: merchant, expiresAt: Math.floor(Date.parse(expiresAt) / 1000), paymentMethod: settings.paymentMethod, metadata, challenge };
}
function tokenFrom(body, id, helper = false) {
  const metadata = {};
  for (const [key, value] of body) { const match = /^shared_metadata\[(.+)\]$/.exec(key); if (match) metadata[match[1]] = value; }
  return { id, object: helper ? 'shared_payment.granted_token' : 'shared_payment.issued_token', livemode: false,
    payment_method: body.get('payment_method'), payment_method_details: { type: 'card' },
    seller_details: { network_business_profile: body.get('seller_details[network_business_profile]') },
    usage_limits: { currency: body.get('usage_limits[currency]'), max_amount: Number(body.get('usage_limits[max_amount]')), expires_at: Number(body.get('usage_limits[expires_at]')) },
    usage_details: { amount_captured: { value: 0, currency: 'usd' } }, shared_metadata: metadata, status: 'active', deactivated_at: null, deactivated_reason: null };
}
function fixture(options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'envar-stripe-issuer-'));
  const statePath = join(directory, 'issuer.sqlite3'), vault = new CredentialVault(join(directory, 'vault'), Buffer.alloc(32, 17));
  const settings = options.config ?? config(), calls = [], tokens = new Map();
  let currentTime = Date.now(), adapter, behavior = '', mutate = value => value, intent;
  const fetchImpl = async (url, init) => {
    const key = init.headers.get('Authorization'), path = new URL(url).pathname;
    calls.push({ url, init, path, key });
    assert.equal(new URL(url).origin, 'https://api.stripe.com');
    assert.equal(init.redirect, 'error'); assert.ok(init.signal instanceof AbortSignal);
    if (behavior === 'network') throw new Error('sk_test_SECRET spt_SECRET network detail');
    if (behavior === 'rate') return Response.json({ error: { message: 'spt_SECRET' } }, { status: 429 });
    if (behavior === 'huge') return new Response('x'.repeat(1024 * 1024 + 1));
    if (behavior === 'json') return new Response('spt_SECRET invalid JSON');
    if (path === '/v1/account') {
      const id = key === 'Bearer ' + settings.secretKey ? settings.issuerAccountId : 'acct_seller';
      return Response.json({ id: behavior === 'account' ? 'acct_foreign' : id, object: behavior === 'account-object' ? 'customer' : 'account', charges_enabled: settings.mode === 'live', capabilities: { card_payments: settings.mode === 'live' ? 'active' : 'inactive' } });
    }
    if (path === '/v2/network/business_profiles/me') return Response.json({ id: behavior === 'profile' ? 'profile_test_foreign' : Object.keys(settings.sellers)[0], object: 'v2.network.business_profile', ...(behavior === 'profile-example' ? {} : { livemode: behavior === 'mode' || settings.mode === 'live' }) });
    if (init.method === 'POST') {
      options.beforePost?.({ statePath, vault });
      const id = 'spt_original' + (tokens.size + 1), body = new URLSearchParams(init.body);
      const value = tokenFrom(body, id, path.includes('test_helpers'));
      value.livemode = settings.mode === 'live';
      tokens.set(id, value);
      if (behavior === 'lost') throw new Error('response lost after original SPT issuance spt_SECRET');
      if (behavior === 'action') value.status = 'requires_action', value.next_action = { type: 'use_stripe_sdk', use_stripe_sdk: { value: 'private-next-action' } };
      return Response.json(mutate(structuredClone(value)));
    }
    if (path.startsWith('/v1/payment_intents/')) return Response.json(intent);
    const value = tokens.get(path.split('/').at(-1));
    return value ? Response.json(value) : Response.json({ error: { message: 'not found' } }, { status: 404 });
  };
  const runtime = { statePath, vault, fetchImpl, now: () => currentTime };
  adapter = createStripeMppBuyer(settings, runtime);
  return { directory, statePath, vault, settings, calls, tokens, runtime,
    get adapter() { return adapter; }, get at() { return currentTime; },
    behavior(value) { behavior = value; }, mutate(fn) { mutate = fn; }, intent(value) { intent = value; }, advance(ms) { currentTime += ms; },
    restart(newConfig = settings) { adapter.close(); adapter = createStripeMppBuyer(newConfig, runtime); },
    posts() { return calls.filter(c => c.init.method === 'POST'); }, close() { adapter.close(); rmSync(directory, { recursive: true, force: true }); } };
}
const receipt = () => ({ method: 'stripe', status: 'success', reference: 'pi_original', timestamp: new Date().toISOString(), externalId: 'quote-original',
  amount: '300', currency: 'usd', merchant: profile, accountId: 'acct_seller', livemode: false });
const context = op => ({ purchaseId: op.purchaseId, quote: op.quote, mode: op.mode, operationId: op.operationId });

test('official issued-token request is persisted encrypted before POST and binds exact frozen scope', async () => {
  let preflightSeen = false;
  const f = fixture({ beforePost({ statePath, vault }) {
    const db = new DatabaseSync(statePath), rows = db.prepare('SELECT * FROM stripe_issuer_operations').all(); db.close();
    assert.equal(rows.length, 1); assert.equal(rows[0].token_ref, null);
    const stored = vault.get(rows[0].request_ref); assert.equal(stored.operation.idempotencyKey, rows[0].idempotency_key);
    assert.equal(new URLSearchParams(stored.body).get('payment_method'), 'pm_authorized'); preflightSeen = true;
  } });
  try {
    const op = operation(f.at); assert.equal(await f.adapter.createToken(op), 'spt_original1'); assert.equal(preflightSeen, true);
    const request = f.posts()[0], body = new URLSearchParams(request.init.body);
    assert.equal(request.path, '/v1/shared_payment/issued_tokens');
    assert.equal(request.init.headers.get('Stripe-Version'), STRIPE_ISSUER_API_VERSION);
    assert.equal(request.init.headers.get('Idempotency-Key'), op.operationId);
    assert.equal(body.get('seller_details[network_business_profile]'), profile);
    assert.equal(body.get('usage_limits[max_amount]'), '300'); assert.equal(body.get('usage_limits[currency]'), 'usd');
    assert.equal(body.get('usage_limits[expires_at]'), String(op.expiresAt));
    assert.equal(body.get('shared_metadata[envarpay_operation]'), op.operationId);
    assert.equal(body.get('shared_metadata[envarpay_order]'), sellerOrder);
    assert.equal(body.get('return_url'), 'https://buyer.example/stripe-return'); assert.equal(body.has('metadata[envarpay_quote]'), false);
    assert.equal(statSync(f.statePath).mode & 0o777, 0o600);
    for (const name of readdirSync(join(f.directory, 'vault'))) {
      const bytes = readFileSync(join(f.directory, 'vault', name));
      for (const sensitive of ['pm_authorized', 'spt_original1', 'sk_test_issuer']) assert.equal(bytes.includes(Buffer.from(sensitive)), false);
    }
    for (const name of readdirSync(f.directory).filter(n => n.startsWith('issuer.sqlite3'))) {
      const bytes = readFileSync(join(f.directory, name));
      for (const sensitive of ['pm_authorized', 'spt_original1', 'sk_test_issuer']) assert.equal(bytes.includes(Buffer.from(sensitive)), false);
    }
  } finally { f.close(); }
});

test('known original SPT survives restart and duplicate create only retrieves it', async () => {
  const f = fixture(); try {
    const op = operation(f.at); await f.adapter.createToken(op); f.restart();
    assert.equal(await f.adapter.recoverToken(op), 'spt_original1');
    assert.equal(await f.adapter.createToken(op), 'spt_original1'); assert.equal(f.posts().length, 1);
    assert.ok(f.calls.some(c => c.path === '/v1/shared_payment/issued_tokens/spt_original1'));
  } finally { f.close(); }
});

test('lost creation response remains unknown across restart without any second POST or invented lookup', async () => {
  const f = fixture(); try {
    const op = operation(f.at); f.behavior('lost');
    await assert.rejects(f.adapter.createToken(op), { code: 'stripe_transport_unknown' }); f.behavior(''); f.restart();
    await assert.rejects(f.adapter.recoverToken(op), { code: 'stripe_spt_recovery_required' });
    await assert.rejects(f.adapter.createToken(op), { code: 'stripe_spt_recovery_required' });
    f.advance(48 * 3600000);
    await assert.rejects(f.adapter.recoverToken(op), { code: 'stripe_spt_recovery_required' });
    assert.equal(f.posts().length, 1); assert.equal(f.tokens.size, 1);
    assert.equal(f.calls.some(c => /search|list/.test(c.path)), false);
  } finally { f.close(); }
});

test('recovery of absent original operation never creates a token', async () => {
  const f = fixture(); try { await assert.rejects(f.adapter.recoverToken(operation(f.at)), { code: 'stripe_spt_recovery_required' }); assert.equal(f.calls.length, 0); } finally { f.close(); }
});

test('scope changes reject before any external call and before funding', async () => {
  const changes = [op => op.amount = '301', op => op.currency = 'eur', op => op.networkId = 'profile_test_foreign', op => op.paymentMethod = 'pm_other', op => op.mode = 'live',
    op => op.expiresAt++, op => op.quote.payer = 'other', op => op.idempotencyKey = 'different', op => op.challenge.request.externalId = 'other',
    op => op.challenge.request.methodDetails.metadata.envarpay_quote = 'other', op => op.challenge.header = 'Authorization'];
  for (const change of changes) {
    const f = fixture(); try { const op = structuredClone(operation(f.at)); change(op); await assert.rejects(f.adapter.createToken(op), { code: 'stripe_spt_binding' }); assert.equal(f.calls.length, 0); } finally { f.close(); }
  }
});

test('expired and overlong authorization windows never POST', async () => {
  for (const offset of [-600000, 3600000]) {
    const f = fixture(); try { await assert.rejects(f.adapter.createToken(operation(f.at + offset)), { code: 'stripe_spt_expiry' }); assert.equal(f.posts().length, 0); } finally { f.close(); }
  }
});

test('same operation cannot be rebound after restart to changed terms or seller account', async () => {
  const f = fixture(); try {
    const op = operation(f.at); await f.adapter.createToken(op);
    const changed = structuredClone(op); changed.quote.messageId = 'new-message';
    await assert.rejects(f.adapter.recoverToken(changed), { code: 'stripe_spt_recovery_binding' });
    const settings = config(); settings.sellers[profile].accountId = 'acct_replaced'; f.restart(settings);
    await assert.rejects(f.adapter.recoverToken(op), { code: 'stripe_spt_recovery_binding' }); assert.equal(f.posts().length, 1);
  } finally { f.close(); }
});

test('a replacement operation ID cannot authorize the same purchase twice', async () => {
  const f = fixture(); try {
    const op = operation(f.at); await f.adapter.createToken(op);
    const replacement = structuredClone(op); replacement.operationId = replacement.idempotencyKey = 'replacement-operation';
    await assert.rejects(f.adapter.createToken(replacement), { code: 'stripe_spt_operation_conflict' }); assert.equal(f.posts().length, 1);
  } finally { f.close(); }
});

test('wrong returned token scope is never accepted; known ID remains recoverable without reminting', async () => {
  const changes = [v => v.livemode = true, v => v.payment_method = 'pm_foreign', v => v.seller_details.network_business_profile = 'profile_test_foreign',
    v => v.usage_limits.max_amount++, v => v.usage_limits.currency = 'eur', v => v.usage_limits.expires_at++, v => v.shared_metadata.envarpay_quote = 'other'];
  for (const change of changes) {
    const f = fixture(); try {
      f.mutate(v => { change(v); return v; }); const op = operation(f.at);
      await assert.rejects(f.adapter.createToken(op), { code: 'stripe_spt_response_binding' }); f.restart();
      assert.equal(await f.adapter.recoverToken(op), 'spt_original1'); assert.equal(f.posts().length, 1);
    } finally { f.close(); }
  }
});

test('requires_action preserves original SPT and exposes only an owner-only Stripe.js action', async () => {
  const f = fixture(); try {
    f.behavior('action'); const op = operation(f.at);
    await assert.rejects(f.adapter.createToken(op), { code: 'stripe_spt_requires_action' }); f.restart();
    await assert.rejects(f.adapter.recoverToken(op), { code: 'stripe_spt_requires_action' });
    assert.deepEqual(await f.adapter.authenticationAction(op.operationId), { type: 'use_stripe_sdk', hashedValue: 'private-next-action' });
    f.tokens.get('spt_original1').status = 'active';
    assert.equal(await f.adapter.authenticationAction(op.operationId), undefined);
    assert.equal(await f.adapter.recoverToken(op), 'spt_original1'); assert.equal(f.posts().length, 1);
  } finally { f.close(); }
});

test('unsupported SCA and consumed tokens cannot be treated as ready funding', async () => {
  const f = fixture(); try {
    f.behavior('action'); const op = operation(f.at);
    await assert.rejects(f.adapter.createToken(op));
    f.tokens.get('spt_original1').next_action = { type: 'redirect_to_url', redirect_to_url: { url: 'https://untrusted.example/' } };
    await assert.rejects(f.adapter.authenticationAction(op.operationId), { code: 'stripe_spt_action_unsupported' });
    f.tokens.get('spt_original1').status = 'deactivated'; f.tokens.get('spt_original1').deactivated_reason = 'consumed';
    await assert.rejects(f.adapter.recoverToken(op), { code: 'stripe_spt_unusable' }); assert.equal(f.posts().length, 1);
  } finally { f.close(); }
});

test('real Stripe test helper is explicit, test-only and bound to the seller account', async () => {
  const settings = config(); settings.issuance = 'test-helper'; settings.issuerAccountId = 'acct_seller'; settings.paymentMethod = 'pm_card_visa';
  const f = fixture({ config: settings }); try {
    const op = operation(f.at, settings); assert.equal(await f.adapter.createToken(op), 'spt_original1');
    assert.equal(f.posts()[0].path, '/v1/test_helpers/shared_payment/granted_tokens');
    const body = new URLSearchParams(f.posts()[0].init.body);
    assert.equal(body.has('seller_details[network_business_profile]'), false); assert.equal(body.get('payment_method'), 'pm_card_visa');
    f.restart(); assert.equal(await f.adapter.recoverToken(op), 'spt_original1');
    assert.ok(f.calls.some(c => c.path === '/v1/shared_payment/granted_tokens/spt_original1'));
    assert.equal(f.calls.some(c => c.path.includes('issued_tokens')), false);
  } finally { f.close(); }
});

test('live-configured adapter uses only the issued-token contract and matching live credentials', async () => {
  const settings = config(); settings.mode = 'live'; settings.secretKey = 'sk_live_issuer';
  settings.sellers = { profile_liveowned: { accountId: 'acct_seller', secretKey: 'rk_live_seller' } };
  const f = fixture({ config: settings }); try {
    const op = operation(f.at, settings); await f.adapter.assertReady(); assert.equal(await f.adapter.createToken(op), 'spt_original1');
    assert.equal(f.posts()[0].path, '/v1/shared_payment/issued_tokens');
    assert.equal(f.posts()[0].key, 'Bearer sk_live_issuer'); assert.equal(f.tokens.get('spt_original1').livemode, true);
    assert.equal(f.calls.some(c => c.path.includes('test_helpers')), false);
  } finally { f.close(); }
});

test('invalid mode, funding and test-helper configuration fails closed before opening a ledger', () => {
  const f = fixture(); try {
    for (const change of [c => c.mode = 'live', c => c.issuance = 'test-helper', c => c.paymentMethod = 'pm_card_visa', c => c.returnUrl = 'http://example.com',
      c => c.sellers[profile].accountId = 'acct_bad/path', c => c.sellers = {}, c => c.secretKey = 'sk_test_secret\nleak']) {
      const value = config(); change(value); assert.throws(() => createStripeMppBuyer(value, f.runtime), error => error.code !== 'store_locked');
    }
    assert.throws(() => createStripeMppBuyer(config(), { ...f.runtime, statePath: ':memory:' }), { code: 'stripe_issuer_state' });
  } finally { f.close(); }
});

test('profile identity, mode and account are independent prerequisites; inactive sandbox is allowed', async () => {
  const f = fixture(); try {
    await f.adapter.assertReady();
    for (const [behavior, code] of [['account', 'stripe_account_mismatch'], ['account-object', 'stripe_account_mismatch'], ['profile', 'stripe_profile_mismatch'], ['mode', 'stripe_profile_mismatch'], ['profile-example', 'stripe_profile_mismatch']]) {
      f.behavior(behavior); await assert.rejects(f.adapter.createToken(operation(f.at)), { code }); assert.equal(f.posts().length, 0);
    }
  } finally { f.close(); }
});

test('receipt verification uses seller-scoped GET and binds amount, mode, order and frozen terms', async () => {
  const f = fixture(); try {
    const op = operation(f.at); await f.adapter.createToken(op);
    const pi = { id: 'pi_original', object: 'payment_intent', status: 'succeeded', amount: 300, amount_received: 300, currency: 'usd', livemode: false,
      metadata: { envarpay_order: sellerOrder, envarpay_quote: op.quote.quoteId, envarpay_terms: op.quote.termsDigest } };
    f.intent(pi); assert.equal(await f.adapter.verifyReceipt(receipt(), context(op)), true);
    const call = f.calls.find(c => c.path === '/v1/payment_intents/pi_original');
    assert.equal(call.key, 'Bearer rk_test_seller'); assert.equal(call.init.method, 'GET');
    for (const mutation of [v => v.amount_received = 299, v => v.amount = 301, v => v.livemode = true, v => v.status = 'processing', v => v.metadata.envarpay_order = purchaseId, v => v.metadata.envarpay_terms = 'other']) {
      const value = structuredClone(pi); mutation(value); f.intent(value); assert.equal(await f.adapter.verifyReceipt(receipt(), context(op)), false);
    }
    for (const mutation of [v => v.accountId = 'acct_foreign', v => v.merchant = 'profile_foreign', v => v.amount = '1', v => v.reference = 'pi_bad/path', v => v.externalId = 'other']) {
      const value = receipt(); mutation(value); const count = f.calls.length; assert.equal(await f.adapter.verifyReceipt(value, context(op)), false); assert.equal(f.calls.length, count);
    }
    assert.equal(f.posts().length, 1);
  } finally { f.close(); }
});

test('network, JSON and provider errors redact credentials; responses are bounded', async () => {
  const f = fixture(); try {
    for (const [behavior, code] of [['network', 'stripe_transport_unknown'], ['json', 'stripe_response'], ['rate', 'stripe_rate_limit'], ['huge', 'stripe_response_size']]) {
      f.behavior(behavior); await assert.rejects(f.adapter.assertReady(), e => e.code === code && !/SECRET/.test(e.message));
    }
    assert.equal(f.posts().length, 0);
  } finally { f.close(); }
});

test('simultaneous creation cannot race into a second token and ledger has one owner', async () => {
  const f = fixture(); try {
    assert.throws(() => createStripeMppBuyer(config(), f.runtime), { code: 'store_locked' });
    const op = operation(f.at), results = await Promise.allSettled([f.adapter.createToken(op), f.adapter.createToken(op)]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(results.find(r => r.status === 'rejected').reason.code, 'stripe_spt_operation_busy'); assert.equal(f.posts().length, 1);
  } finally { f.close(); }
});

test('actual CommerceBuyer and native MPP gate complete only after original SPT action and independent receipt', async () => {
  const f = fixture(), store = new BuyerStore(join(f.directory, 'buyer.sqlite3')), sellerStore = new CommerceStore(':memory:');
  const origin = 'https://seller.example', identity = 'a'.repeat(40), intents = new Map();
  let paidRequests = 0, executions = 0, paymentIntents = 0;
  const provider = { accountId: 'acct_seller', merchantProfile: profile, mode: 'test', async assertReady() {},
    async create(params) {
      paymentIntents++;
      const intent = { id: 'pi_original', object: 'payment_intent', status: 'succeeded', amount: params.amount, amount_received: params.amount,
        currency: params.currency, livemode: false, metadata: params.metadata };
      intents.set(intent.id, intent); f.intent(intent); return intent;
    }, async retrieve(id) { return intents.get(id); }, async findOriginal(id) { return [...intents.values()].find(v => v.metadata.envarpay_order === id); } };
  const gate = new MppGate({ store: sellerStore, vault: new CredentialVault(join(f.directory, 'seller-vault'), Buffer.alloc(32, 18)), origin,
    hmacSecret: 'test-only-hmac-key-32-characters-long', providers: { 'seller-stripe': provider } });
  const sellerConfig = loadCommerceConfig(JSON.parse(readFileSync(new URL('../examples/seller.json', import.meta.url), 'utf8')));
  const seller = new CommerceServer({ config: sellerConfig, origin, store: sellerStore, authenticate: bearerAuthenticator({ [identity]: 'buyer' }), paymentGate: gate,
    stripeRecipientFor: () => profile, execute: async function* (order) { executions++; yield Task.fromJSON({ id: 'upstream-' + order.id,
      status: { state: 'TASK_STATE_COMPLETED' }, artifacts: [{ artifactId: 'report', parts: [{ text: 'fixture result' }] }] }); } });
  const cardUrl = origin + '/services/research/v1/offers/card-once/agent-card.json';
  const buyer = new CommerceBuyer({ mpp: f.adapter, vault: f.vault, store, peerTokens: { seller: identity },
    policy: { policyVersion: 1, paymentsEnabled: true, approval: 'per_purchase', peers: [{ id: 'seller', cardUrl, protocol: 'mpp', currency: 'usd', recipient: profile, maxPerPurchase: '300' }],
      budgets: [{ currency: 'usd', maxTotal: '300', period: 'cumulative' }] },
    fetchImpl: async (url, init) => { const request = new Request(url, init); if (request.headers.has('Payment-Authorization')) paidRequests++; return seller.handle(request); } });
  try {
    f.behavior('action');
    const preview = await buyer.preview('owner', { cardUrl, messageId: 'action-integration', offerId: 'card-once', input: { topic: 'test', competitors: ['A'] } });
    const waiting = await buyer.confirm('owner', { previewId: preview.id, quoteToken: preview.quoteToken, messageId: preview.messageId });
    assert.equal(waiting.paymentState, 'unknown'); assert.equal(waiting.errorCode, 'stripe_spt_requires_action');
    assert.equal(paidRequests, 0); assert.equal(executions, 0); assert.equal(paymentIntents, 0);
    assert.deepEqual(store.usage('usd'), { reserved: '300', spent: '0' });
    const action = await f.adapter.authenticationAction('mpp-token-' + waiting.id); assert.equal(action.type, 'use_stripe_sdk');
    // Fixture simulates customer completion; no browser/SCA or real payment is claimed.
    f.tokens.get('spt_original1').status = 'active';
    await buyer.recover('owner', waiting.id);
    while (seller.isRunning) await new Promise(resolve => setTimeout(resolve, 1));
    const done = await buyer.recover('owner', waiting.id);
    assert.equal(done.paymentState, 'confirmed'); assert.equal(done.executionState, 'completed');
    assert.equal(paymentIntents, 1); assert.equal(executions, 1); assert.equal(f.posts().length, 1);
    assert.deepEqual(store.usage('usd'), { reserved: '0', spent: '300' });
    assert.equal(JSON.stringify(done).includes('spt_original1'), false);
    assert.ok(f.calls.some(c => c.path === '/v1/payment_intents/pi_original' && c.key === 'Bearer rk_test_seller'));
  } finally { await buyer.stop(); seller.stop(); while (seller.isRunning) await new Promise(resolve => setTimeout(resolve, 1)); store.close(); sellerStore.close(); f.close(); }
});
