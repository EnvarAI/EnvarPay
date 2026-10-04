import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { BuyerManagement, listenBuyerManagement } from '../dist/commerce/management.js';
import { bearerAuthenticator } from '../dist/commerce/server.js';
import { CommerceError } from '../dist/commerce/types.js';
const token = 'a'.repeat(40), otherToken = 'b'.repeat(40), id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
function fixture(origin = 'http://127.0.0.1:4021') {
  const calls = [];
  const buyer = {
    policySnapshot: () => ({ state: 'ready', capabilities: ['x402'], peers: [] }),
    preview: async (caller, input) => { calls.push(['preview', caller, input]); return { id, state: 'previewed' }; },
    confirm: async (caller, input) => { calls.push(['confirm', caller, input]); return { id, state: 'unknown' }; },
    get: (caller, purchase) => { calls.push(['get', caller, purchase]); if (caller !== 'owner') throw new CommerceError('purchase_not_found', 'Private order'); return { id, state: 'unknown' }; },
    recover: async (caller, purchase) => { calls.push(['recover', caller, purchase]); if (caller !== 'owner') throw new CommerceError('purchase_not_found', 'Private order'); return { id, state: 'unknown' }; },
    authentication: async (caller, purchase) => { calls.push(['authentication', caller, purchase]); if (caller !== 'owner') throw new CommerceError('purchase_not_found', 'Private order'); return { purchaseId: purchase, action: null }; },
  };
  const management = new BuyerManagement({ buyer, origin, authenticate: bearerAuthenticator({ [token]: 'owner', [otherToken]: 'other' }) });
  const request = (path, body, options = {}) => new Request(origin + path, { method: body !== undefined ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + token, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...options.headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), ...options });
  return { management, calls, request };
}

test('private management authenticates every route and keeps readback free of recovery', async () => {
  const f = fixture();
  const denied = await f.management.handle(new Request('http://127.0.0.1:4021/management/v1/policy'));
  assert.equal(denied.status, 401); assert.deepEqual(f.calls, []);
  const policy = await f.management.handle(f.request('/management/v1/policy')); assert.equal(policy.status, 200); assert.equal(policy.headers.get('Cache-Control'), 'no-store');
  const read = await f.management.handle(f.request('/management/v1/purchases/' + id)); assert.equal(read.status, 200); assert.deepEqual(f.calls, [['get', 'owner', id]]);
  const other = f.request('/management/v1/purchases/' + id); other.headers.set('Authorization', 'Bearer ' + otherToken);
  assert.equal((await f.management.handle(other)).status, 404);
});

test('authentication is owner-scoped GET only with no arbitrary operation input and no cache', async () => {
  const f = fixture(), path = '/management/v1/purchases/' + id + '/authentication';
  assert.equal((await f.management.handle(new Request('http://127.0.0.1:4021' + path))).status, 401);
  assert.deepEqual(f.calls, []);
  const response = await f.management.handle(f.request(path));
  assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await response.json(), { purchaseId: id, action: null });
  const other = f.request(path); other.headers.set('Authorization', 'Bearer ' + otherToken);
  assert.equal((await f.management.handle(other)).status, 404);
  const count = f.calls.length;
  assert.equal((await f.management.handle(f.request(path + '?operationId=another'))).status, 400);
  assert.equal((await f.management.handle(f.request(path, { operationId: 'another' }))).status, 404);
  assert.equal((await f.management.handle(f.request('/management/v1/purchases/mpp-token-' + id + '/authentication'))).status, 404);
  const cross = f.request(path); cross.headers.set('Origin', 'https://foreign.example');
  assert.equal((await f.management.handle(cross)).status, 403);
  assert.equal(f.calls.length, count);
  assert.equal(f.calls.some(c => c[0] === 'recover' || c[0] === 'confirm'), false);
});

test('management preview and approval reject extra target/amount fields', async () => {
  const f = fixture(), preview = { cardUrl: 'https://seller.example/agent-card.json', messageId: 'stable', input: {}, offerId: 'paid' };
  assert.equal((await f.management.handle(f.request('/management/v1/purchases/preview', preview))).status, 200);
  assert.equal(f.calls[0][1], 'owner');
  assert.equal((await f.management.handle(f.request('/management/v1/purchases/preview', { ...preview, amount: '1' }))).status, 400);
  const confirmation = { previewId: id, quoteToken: 'reviewed', messageId: 'stable' };
  assert.equal((await f.management.handle(f.request('/management/v1/purchases/confirm', confirmation))).status, 200);
  assert.equal((await f.management.handle(f.request('/management/v1/purchases/confirm', { ...confirmation, recipient: 'other' }))).status, 400);
  assert.equal((await f.management.handle(f.request('/management/v1/purchases/' + id + '/recover', {}))).status, 200);
});

test('strict host/origin, HTTPS remote config, body limits and redacted errors', async () => {
  const f = fixture();
  assert.throws(() => fixture('http://wallet.example'), { code: 'management_origin' });
  assert.equal((await f.management.handle(new Request('http://evil.example/management/v1/policy'))).status, 421);
  const cross = f.request('/management/v1/policy'); cross.headers.set('Origin', 'https://evil.example'); assert.equal((await f.management.handle(cross)).status, 403);
  const huge = f.request('/management/v1/purchases/preview', { large: 'x'.repeat(1024 * 1024) }); assert.equal((await f.management.handle(huge)).status, 413);
  assert.throws(() => listenBuyerManagement(f.management, f.management.origin, '0.0.0.0'), { code: 'management_bind' });
});

test('loopback listener rejects wrong Host before routing', async () => {
  const f = fixture(), server = listenBuyerManagement(f.management, f.management.origin, '127.0.0.1', 0);
  await once(server, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/management/v1/policy`, { headers: { Authorization: 'Bearer ' + token } });
    assert.equal(response.status, 421); assert.deepEqual(f.calls, []);
  } finally { server.close(); await once(server, 'close'); }
});
