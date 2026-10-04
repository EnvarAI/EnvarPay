import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BuyerStore } from '../dist/commerce/buyer-store.js';
import { createStripeMppBuyer } from '../dist/commerce/stripe-issuer.js';
import { CredentialVault } from '../dist/commerce/vault.js';

const ownerToken = 'test-owner-credential-only-for-cli-fixture';
const profile = 'profile_test_seller';
const issuerKey = 'sk_test_issuer', sellerKey = 'rk_test_seller';

async function fixture(scenario = 'ready', paymentMethod = 'pm_card_visa') {
  const directory = mkdtempSync(join(tmpdir(), 'envar-stripe-cli-'));
  const reserve = createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  const state = join(directory, 'buyer.sqlite3');
  const config = { policyVersion: 1, paymentsEnabled: false, approval: 'per_purchase', peers: [{ id: 'seller', cardUrl: 'https://seller.example/card.json', protocol: 'mpp', currency: 'usd', recipient: profile, maxPerPurchase: '50' }], budgets: [{ currency: 'usd', maxTotal: '50', period: 'cumulative' }] };
  const credentials = { callers: { [ownerToken]: 'owner' }, peerTokens: { seller: 'test-seller-token-not-for-provider' }, vaultKeyFile: join(directory, 'vault.key'), mppStripe: {
    payer: 'owner', mode: 'test', issuerAccountId: 'acct_issuer', secretKeyFile: join(directory, 'issuer.key'), paymentMethod: 'pm_authorized', publishableKey: 'pk_test_issuer',
    sellers: { [profile]: { accountId: 'acct_seller', secretKeyFile: join(directory, 'seller.key') } },
  } };
  if (scenario === 'helper') {
    credentials.mppStripe.issuance = 'test-helper';
    credentials.mppStripe.paymentMethod = paymentMethod;
    credentials.mppStripe.sellers[profile] = { accountId: 'acct_issuer', secretKeyFile: join(directory, 'issuer.key') };
  }
  if (scenario === 'dual') credentials.mppAdapterModule = join(directory, 'unused-module.mjs');
  if (scenario === 'wrong-key') credentials.mppStripe.publishableKey = 'pk_live_wrongmode';
  for (const [name, contents] of [['policy.json', JSON.stringify(config)], ['credentials.json', JSON.stringify(credentials)], ['issuer.key', issuerKey], ['seller.key', sellerKey]]) writeFileSync(join(directory, name), contents, { mode: 0o600 });
  writeFileSync(credentials.vaultKeyFile, Buffer.alloc(32, 7), { mode: 0o600 });
  const preloader = join(directory, 'provider-fixture.mjs');
  writeFileSync(preloader, `import {appendFileSync} from 'node:fs';
globalThis.fetch=async(input,init)=>{
 const request=new Request(input,init),url=new URL(request.url);
 appendFileSync(${JSON.stringify(join(directory, 'provider.log'))},request.method+' '+url.pathname+'\\n',{mode:0o600});
 if(url.origin!=='https://api.stripe.com'||request.method!=='GET')throw Error('Unexpected external operation');
 const token=request.headers.get('Authorization');
 if(request.headers.get('Stripe-Version')!=='2026-09-30.preview')throw Error('Unexpected version');
 if(url.pathname==='/v1/account')return Response.json({object:'account',id:token==='Bearer ${issuerKey}'?'acct_issuer':'acct_seller',charges_enabled:false,capabilities:{card_payments:'inactive'}});
 if(url.pathname==='/v2/network/business_profiles/me')return Response.json({object:'v2.network.business_profile',id:'${scenario === 'mismatch' ? 'profile_test_other' : profile}',livemode:false});
 throw Error('Unexpected provider path');
};`, { mode: 0o600 });
  const child = spawn(process.execPath, ['--import', preloader, new URL('../dist/commerce/cli.js', import.meta.url).pathname, 'buyer-serve', '--config', join(directory, 'policy.json'), '--credentials', join(directory, 'credentials.json'), '--state', state, '--origin', `http://127.0.0.1:${port}`, '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
  const exited = once(child, 'exit');
  return { directory, state, port, child, exited, credentials, output: () => ({ stdout, stderr }), calls: () => existsSync(join(directory, 'provider.log')) ? readFileSync(join(directory, 'provider.log'), 'utf8').trim().split('\n') : [], close: async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await exited; }
    rmSync(directory, { recursive: true, force: true });
  } };
}

test('built-in Stripe CLI starts with private key files and GET-only readiness, then releases both ledgers on shutdown', async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 200 && !f.output().stdout.includes('listening') && f.child.exitCode === null; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(f.output().stdout.includes('listening'), f.output().stderr);
    assert.deepEqual(f.calls(), ['GET /v1/account', 'GET /v1/account', 'GET /v2/network/business_profiles/me']);
    const response = await fetch(`http://127.0.0.1:${f.port}/management/v1/policy`, { headers: { Authorization: `Bearer ${ownerToken}` } });
    const snapshot = await response.json();
    assert.equal(response.status, 200); assert.deepEqual(snapshot.capabilities, ['mpp']);
    assert.equal(snapshot.paymentsEnabled, false); assert.equal(snapshot.approval, 'per_purchase');
    assert.equal(JSON.stringify(snapshot).includes(issuerKey), false);
    assert.equal(f.output().stdout.includes(issuerKey), false); assert.equal(f.output().stderr.includes(sellerKey), false);
    f.child.kill('SIGTERM'); const [code] = await f.exited; assert.equal(code, 0);
    const store = new BuyerStore(f.state); assert.deepEqual(store.usage('usd'), { reserved: '0', spent: '0' }); store.close();
    const adapter = createStripeMppBuyer({ payer: 'owner', mode: 'test', issuerAccountId: 'acct_issuer', secretKey: issuerKey, paymentMethod: 'pm_authorized', sellers: { [profile]: { accountId: 'acct_seller', secretKey: sellerKey } } }, { statePath: f.state + '.stripe-issuer.sqlite3', vault: new CredentialVault(join(f.directory, 'buyer-authorizations'), Buffer.alloc(32, 7)), fetchImpl: async () => { throw new Error('Opening a ledger must not contact a provider'); } });
    adapter.close();
  } finally { await f.close(); }
});

test('built-in Stripe CLI refuses competing adapters, publishable key mode and profile mismatch before exposing management', async () => {
  for (const scenario of ['dual', 'mismatch', 'wrong-key']) {
    const f = await fixture(scenario);
    try {
      const [code] = await f.exited; assert.equal(code, 1);
      assert.equal(f.output().stdout.includes('listening'), false);
      assert.ok(f.output().stderr.includes(scenario === 'dual' ? 'mpp_configuration' : scenario === 'wrong-key' ? 'stripe_publishable_key' : 'stripe_profile_mismatch'));
      assert.equal(f.calls().some(line => line.startsWith('POST')), false);
      if (scenario !== 'mismatch') assert.deepEqual(f.calls(), []);
      assert.equal(f.output().stderr.includes(issuerKey), false);
    } finally { await f.close(); }
  }
});

for (const paymentMethod of ['pm_card_visa', 'pm_card_visa_chargeDeclined', 'pm_card_authenticationRequired']) test(`documented sandbox ${paymentMethod} starts through explicit helper without issuance`, async () => {
  const f = await fixture('helper', paymentMethod);
  try {
    for (let i = 0; i < 200 && !f.output().stdout.includes('listening') && f.child.exitCode === null; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(f.output().stdout.includes('listening'), f.output().stderr);
    assert.deepEqual(f.calls(), ['GET /v1/account', 'GET /v1/account', 'GET /v2/network/business_profiles/me']);
    const response = await fetch(`http://127.0.0.1:${f.port}/management/v1/policy`, { headers: { Authorization: `Bearer ${ownerToken}` } });
    assert.equal(response.status, 200); assert.equal((await response.json()).paymentsEnabled, false);
  } finally { await f.close(); }
});
