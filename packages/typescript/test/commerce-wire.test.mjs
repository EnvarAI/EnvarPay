import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Task } from '@a2a-js/sdk';
import { CommerceServer, CommerceStore } from '../dist/commerce/runtime.js';
import { loadCommerceConfig } from '../dist/commerce/index.js';

const origin = 'https://seller.example';
const paidPath = '/services/research/v1/offers/usdc-once/a2a';
const freePath = '/services/summary-preview/v1/offers/free/a2a';
const caller = 'wire-test-owner';

function fixture() {
  const config = loadCommerceConfig(JSON.parse(readFileSync(new URL('../examples/seller.json', import.meta.url), 'utf8')));
  const store = new CommerceStore(':memory:');
  const calls = { payment: 0, execute: 0 };
  const server = new CommerceServer({
    config, store, origin, authenticate: async () => caller,
    paymentGate: { handle: async () => { calls.payment++; return { response: Response.json({ fixture: 'payment challenge' }, { status: 402 }) }; } },
    execute: async function* (order) {
      calls.execute++;
      yield Task.fromJSON({ id: 'remote-' + order.id, status: { state: 'TASK_STATE_COMPLETED' }, artifacts: [{ artifactId: 'result', parts: [{ text: 'free fixture output' }] }] });
    },
  });
  return { store, calls, server, close: async () => { server.stop(); while (server.isRunning) await new Promise(resolve => setTimeout(resolve, 1)); store.close(); } };
}

function request({ path = paidPath, version = '1.0', mediaType = 'application/json', id = 'rpc-original', messageId = 'message-original' } = {}) {
  const headers = new Headers();
  if (version !== null) headers.set('A2A-Version', version);
  if (mediaType !== null) headers.set('Content-Type', mediaType);
  const body = { jsonrpc: '2.0', id, method: 'SendMessage', params: { message: { messageId, role: 'ROLE_USER', parts: [{ data: path === paidPath ? { topic: 'bounded fixture', competitors: ['A'] } : { text: 'free fixture' } }] } } };
  return new Request(origin + path, { method: 'POST', headers, body: JSON.stringify(body) });
}

function assertProtocolError(response, body, id, code, reason) {
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('A2A-Version'), '1.0');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.match(response.headers.get('Content-Type'), /^application\/json/);
  assert.equal(body.jsonrpc, '2.0'); assert.equal(body.id, id);
  assert.equal(body.result, undefined); assert.equal(body.error.code, code);
  assert.equal(typeof body.error.message, 'string');
  assert.ok(Array.isArray(body.error.data));
  assert.ok(body.error.data.some(value => value['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo' && value.reason === reason));
}

test('unsupported or missing A2A versions return the official correlated error before quoting or payment', async () => {
  const f = fixture();
  try {
    for (const [index, version] of [null, '', '0.3', '99.0'].entries()) {
      const id = index % 2 ? index : 'request-' + index, messageId = 'version-' + index;
      const response = await f.server.handle(request({ version, id, messageId }));
      assertProtocolError(response, await response.json(), id, -32009, 'VERSION_NOT_SUPPORTED');
      assert.equal(f.store.findOrder(caller, 'research:1', messageId), undefined);
    }
    assert.deepEqual(f.calls, { payment: 0, execute: 0 });
  } finally { await f.close(); }
});

test('unsupported request media types return the official correlated error without executing valid paid or free input', async () => {
  const f = fixture();
  try {
    for (const path of [paidPath, freePath]) {
      for (const [index, mediaType] of [null, '', 'text/plain', 'application/jsonp', 'application/problem+json', 'application/json, text/plain'].entries()) {
        const id = 'media-' + index, messageId = `${path === paidPath ? 'paid' : 'free'}-media-${index}`;
        const response = await f.server.handle(request({ path, mediaType, id, messageId }));
        assertProtocolError(response, await response.json(), id, -32005, 'CONTENT_TYPE_NOT_SUPPORTED');
        assert.equal(f.store.findOrder(caller, path === paidPath ? 'research:1' : 'summary-preview:1', messageId), undefined);
      }
    }
    assert.deepEqual(f.calls, { payment: 0, execute: 0 });
  } finally { await f.close(); }
});

test('JSON media types accept normal parameters and casing while preserving the original payment boundary', async () => {
  const f = fixture();
  try {
    for (const [index, mediaType] of ['application/json', 'application/json; charset=utf-8', 'Application/JSON; Charset=UTF-8'].entries()) {
      const response = await f.server.handle(request({ mediaType, messageId: 'valid-' + index }));
      assert.equal(response.status, 402);
      assert.equal(f.store.findOrder(caller, 'research:1', 'valid-' + index).paymentState, 'quoted');
    }
    assert.deepEqual(f.calls, { payment: 3, execute: 0 });
    const free = await f.server.handle(request({ path: freePath, mediaType: 'application/json; charset=utf-8', messageId: 'valid-free' }));
    assert.equal((await free.json()).result.task.status.state, 'TASK_STATE_COMPLETED');
    assert.deepEqual(f.calls, { payment: 3, execute: 1 });
  } finally { await f.close(); }
});
