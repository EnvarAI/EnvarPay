import test from 'node:test';
import assert from 'node:assert/strict';
import { stripeProvider, STRIPE_MPP_API_VERSION } from '../dist/commerce/stripe-provider.js';
import { loadBuyerPolicy, isStripeProfileId } from '../dist/commerce/config.js';

const options = { idempotencyKey: 'stable-original-key', apiVersion: '2026-07-29.preview' };
const params = { amount: 50, currency: 'usd', confirm: true, metadata: { envarpay_order: 'original' }, shared_payment_granted_token: 'spt_fixture' };

function fixture(mode = 'live', secretKey = `sk_${mode}_fixture`) {
  const merchantProfile = mode === 'test' ? 'profile_test_owned' : 'profile_owned';
  const config = { secretKey, accountId: 'acct_owned', merchantProfile, mode };
  const calls = [];
  let state = 'ready';
  const provider = stripeProvider(config, async (url, init) => {
    calls.push({ url, init });
    if (state === 'network') throw new Error('sk_live_fixture spt_secret interrupted request');
    if (state === 'stream') return new Response(new ReadableStream({ start(controller) { controller.error(new Error('spt_secret stream failed')); } }));
    if (state === 'error') return Response.json({ error: { message: 'spt_secret MUST NOT LEAK' } }, { status: 402 });
    if (state === 'redirect') return new Response(null, { status: 302, headers: { location: 'https://evil.example' } });
    if (state === 'large') return new Response('x'.repeat(1024 * 1024 + 1));
    if (url.endsWith('/account')) return Response.json({ object: 'account', id: state === 'other-account' ? 'acct_other' : 'acct_owned', charges_enabled: state !== 'disabled', capabilities: { card_payments: state === 'pending-cards' ? 'pending' : 'active' } });
    if (url.endsWith('/business_profiles/me')) return Response.json({ object: state === 'wrong-object' ? 'account' : 'v2.network.business_profile', id: state === 'other-profile' ? 'profile_other' : merchantProfile, ...(state === 'no-mode-field' ? {} : { livemode: state === 'wrong-mode' ? mode !== 'live' : mode === 'live' }) });
    if (url.includes('/payment_intents/search')) return Response.json({ data: [], has_more: false });
    return Response.json({ id: 'pi_original', status: 'succeeded', amount: 50, amount_received: 50, currency: 'usd', livemode: mode === 'live', metadata: { envarpay_order: 'original' } });
  });
  return { provider, calls, config, state: value => { state = value; } };
}

test('Stripe readiness proves the profile through the authenticated me endpoint and pins one public preview version', async () => {
  const f = fixture();
  await f.provider.assertReady();
  assert.deepEqual(f.calls.map(call => call.url), ['https://api.stripe.com/v1/account', 'https://api.stripe.com/v2/network/business_profiles/me']);
  for (const call of f.calls) {
    assert.equal(call.init.method, 'GET'); assert.equal(call.init.body, undefined);
    assert.equal(call.init.headers.get('Authorization'), 'Bearer sk_live_fixture');
    assert.equal(call.init.headers.get('Stripe-Version'), STRIPE_MPP_API_VERSION);
    assert.equal(call.init.redirect, 'error'); assert.ok(call.init.signal);
  }
  f.state('no-mode-field'); await assert.rejects(f.provider.assertReady(), { code: 'stripe_profile_mismatch' });
});

test('account, profile and mode mismatches fail closed; only live mode requires active card charges', async () => {
  const live = fixture();
  for (const [state, code] of [['other-account', 'stripe_account_mismatch'], ['other-profile', 'stripe_profile_mismatch'], ['wrong-object', 'stripe_profile_mismatch'], ['wrong-mode', 'stripe_profile_mismatch'], ['disabled', 'stripe_charges_disabled'], ['pending-cards', 'stripe_charges_disabled']]) {
    live.state(state); await assert.rejects(live.provider.assertReady(), { code });
  }
  const sandbox = fixture('test', 'rk_test_fixture');
  sandbox.state('disabled'); await sandbox.provider.assertReady();
  sandbox.state('pending-cards'); await sandbox.provider.assertReady();
  sandbox.state('wrong-mode'); await assert.rejects(sandbox.provider.assertReady(), { code: 'stripe_profile_mismatch' });
  assert.throws(() => stripeProvider({ ...live.config, secretKey: 'sk_test_fixture' }), { code: 'stripe_configuration' });
  assert.throws(() => stripeProvider({ ...live.config, merchantProfile: 'profile_test_owned' }), { code: 'stripe_configuration' });
});

test('documented sandbox profile IDs are accepted by local policy without weakening bounded profile syntax', () => {
  const valid = 'profile_test_61UQtAVw2yEA80y4mA6UQtAVBKSQt4084jw8nwJXUUdk';
  assert.equal(isStripeProfileId(valid), true);
  for (const invalid of ['profile_', 'profile_test_', 'profile_test_a_b', 'profile_../../key', 'profile_' + 'a'.repeat(121)]) assert.equal(isStripeProfileId(invalid), false);
  const policy = loadBuyerPolicy({ policyVersion: 1, paymentsEnabled: false, approval: 'per_purchase', peers: [{ id: 'sandbox', cardUrl: 'https://seller.example/card.json', protocol: 'mpp', currency: 'usd', recipient: valid, maxPerPurchase: '50' }], budgets: [{ currency: 'usd', maxTotal: '50', period: 'cumulative' }] });
  assert.equal(policy.peers[0].recipient, valid);
});

test('SPT consumption maps the original SDK credential to the documented PaymentIntent field and keeps idempotency', async () => {
  const f = fixture();
  await f.provider.create(params, options);
  const call = f.calls.at(-1);
  assert.equal(call.url, 'https://api.stripe.com/v1/payment_intents');
  assert.equal(call.init.headers.get('Idempotency-Key'), options.idempotencyKey);
  assert.equal(call.init.headers.get('Stripe-Version'), '2026-09-30.preview');
  assert.equal(call.init.body.get('payment_method_data[shared_payment_granted_token]'), 'spt_fixture');
  assert.equal(call.init.body.has('shared_payment_granted_token'), false);
  assert.equal(call.init.body.get('metadata[envarpay_order]'), 'original');
  assert.equal(call.init.body.get('confirm'), 'true');
  assert.equal(call.init.body.get('amount'), '50');
});

test('invalid SPT consumption cannot reach the provider', async () => {
  const f = fixture();
  for (const patch of [{ amount: 49 }, { amount: 999999999 }, { currency: 'eur' }, { confirm: false }, { shared_payment_granted_token: 'not-token' }, { payment_method: 'pm_other' }, { payment_method_data: {} }]) await assert.rejects(f.provider.create({ ...params, ...patch }, options), { code: 'stripe_request' });
  await assert.rejects(f.provider.create(params, { ...options, idempotencyKey: '' }), { code: 'stripe_request' });
  assert.equal(f.calls.length, 0);
});

test('provider errors, redirects and excessive responses stay bounded and never expose payment secrets', async () => {
  const f = fixture();
  for (const state of ['error', 'redirect', 'large', 'network', 'stream']) {
    f.state(state);
    await assert.rejects(f.provider.assertReady(), error => !error.message.includes('spt_secret') && !error.message.includes('sk_live') && error.code.startsWith('stripe_'));
  }
  assert.equal(f.calls.length, 5);
  assert.ok(f.calls.every(call => call.url === 'https://api.stripe.com/v1/account' && call.init.redirect === 'error'));
});

test('original PaymentIntent reconciliation remains GET-only under the same merchant credential/version', async () => {
  const f = fixture();
  await f.provider.retrieve('pi_original');
  await f.provider.findOriginal('12345678-1234-1234-1234-123456789012');
  assert.ok(f.calls.every(call => call.init.method === 'GET' && call.init.headers.get('Stripe-Version') === STRIPE_MPP_API_VERSION));
  assert.equal(f.calls[0].url, 'https://api.stripe.com/v1/payment_intents/pi_original');
  assert.ok(f.calls[1].url.startsWith('https://api.stripe.com/v1/payment_intents/search?'));
});
