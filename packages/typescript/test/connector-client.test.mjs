import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { EnvarWorkClient, WorkApiError } from '../dist/connector/client.js';
import { WORK_SCHEMA_SHA256 } from '../dist/connector/contracts.generated.js';

const token = 'envar_agent_' + 't'.repeat(43);
function work() {
  return { id: randomUUID(), context_id: randomUUID(), caller_agent_id: null, target_agent_id: randomUUID(),
    endpoint_id: null, connection_id: randomUUID(), target_name: 'Receiver', target_handle: '', status: 'queued',
    request: { message: 'A bounded task', tool: '', arguments: {} }, result: {}, error_code: '', remote_task_id: '',
    cancel_requested_at: null, deadline_at: new Date(Date.now() + 60000).toISOString(),
    created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
}
test('contract types have the exact canonical schema digest', () => {
  const source = readFileSync(new URL(import.meta.resolve('@envarai/connect/contracts/agent-work/v1/schema.json')));
  assert.equal(createHash('sha256').update(source).digest('hex'), WORK_SCHEMA_SHA256);
});
test('client preserves the work/request identity and cannot use undeclared send fields', async () => {
  const row = work(), calls = [], key = randomUUID();
  const client = new EnvarWorkClient('https://envar.example', token, { fetch: async (url, init) => {
    calls.push({ url, init }); return Response.json(row);
  } });
  assert.equal((await client.send({ target_agent_id: row.target_agent_id, message: 'A bounded task' }, key)).id, row.id);
  assert.equal(calls[0].url.origin, 'https://envar.example');
  assert.equal(calls[0].init.headers.get('Authorization'), 'Bearer ' + token);
  assert.equal(calls[0].init.headers.get('Idempotency-Key'), key);
  assert.equal(calls[0].init.redirect, 'error');
  await assert.rejects(client.send({ target_agent_id: row.target_agent_id, message: 'A bounded task', externally_executed: true }, key));
  assert.equal(calls.length, 1);
});
test('unknown POST outcome is returned to the journal without a hidden retry', async () => {
  let count = 0;
  const client = new EnvarWorkClient('https://envar.example', token, { fetch: async () => {
    count++; throw new Error('response lost after send');
  } });
  await assert.rejects(client.send({ target_agent_id: randomUUID(), message: 'Once only' }, randomUUID()));
  assert.equal(count, 1);
});
test('throttle and revoked credentials preserve the API status without logging its body', async () => {
  const client = new EnvarWorkClient('https://envar.example', token, { fetch: async () =>
    Response.json({ private: 'must not enter logs' }, { status: 429, headers: { 'Retry-After': '12' } }) });
  await assert.rejects(client.inbox(), error => error instanceof WorkApiError && error.retryAfter === 12 &&
    error.status === 429 && !error.message.includes('private'));
});
test('HTTP redirects never forward the connection credential', async t => {
  let leaked = 0;
  const destination = createServer((_req, res) => { leaked++; res.end('{}'); });
  await new Promise(resolve => destination.listen(0, '127.0.0.1', resolve));
  const source = createServer((_req, res) => {
    res.writeHead(302, { Location: `http://127.0.0.1:${destination.address().port}/capture` }); res.end();
  });
  await new Promise(resolve => source.listen(0, '127.0.0.1', resolve));
  t.after(() => { source.closeAllConnections(); source.close(); destination.closeAllConnections(); destination.close(); });
  const client = new EnvarWorkClient(`http://127.0.0.1:${source.address().port}`, token, { allowLocalHttp: true });
  await assert.rejects(client.inbox());
  assert.equal(leaked, 0);
});
test('claim responses retain lease and original execution reference', async () => {
  const row = work(), claim = { id: randomUUID(), fence: 2, lease_until: new Date().toISOString() };
  const client = new EnvarWorkClient('https://envar.example', token, { fetch: async () =>
    Response.json({ ...row, claim, execution_ref: { key: row.id }, replayed: true }) });
  const result = await client.claim(row.id, claim.id);
  assert.deepEqual(result.claim, claim);
  assert.deepEqual(result.execution_ref, { key: row.id });
  assert.equal(result.replayed, true);
});
test('work canceled before its first claim needs no fabricated execution claim', async () => {
  const row = { ...work(), status: 'canceled' };
  const client = new EnvarWorkClient('https://envar.example', token, { fetch: async () =>
    Response.json({ ...row, claim: { id: null, fence: 0, lease_until: null }, execution_ref: {} }) });
  const result = await client.claim(row.id, randomUUID());
  assert.equal(result.status, 'canceled'); assert.equal(result.claim, undefined);
});
