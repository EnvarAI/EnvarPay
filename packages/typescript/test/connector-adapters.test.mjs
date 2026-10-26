import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { HermesRuntimeAdapter } from '../dist/adapters/hermes.js';
import { OpenClawRuntimeAdapter } from '../dist/adapters/openclaw.js';
import { RuntimeOutcomeUnknown } from '../dist/adapters/types.js';

function fixture(Adapter) {
  const calls = [], state = { phase: 'TASK_STATE_WORKING', taskId: 'native-original', missing: false, loseSend: false };
  const card = { name: 'Native Agent', description: 'Existing real runtime', version: '1', capabilities: {},
    defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'], skills: [],
    supportedInterfaces: [{ url: 'http://127.0.0.1:9900/a2a/v1', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }] };
  const adapter = new Adapter({ cardUrl: 'http://127.0.0.1:9900/.well-known/agent-card.json', token: 'native-test-peer-secret',
    fetch: async input => {
      const request = new Request(input);
      assert.equal(request.headers.get('Authorization'), 'Bearer native-test-peer-secret');
      assert.equal(request.redirect, 'error');
      if (request.method === 'GET') return Response.json(card);
      const body = await request.json();
      if (body.method === 'GetTask' && body.params.id.startsWith('envar-connection-probe-'))
        return Response.json({ jsonrpc: '2.0', id: body.id, error: { code: -32001, message: 'Task not found' } });
      calls.push(body);
      if (body.method === 'SendMessage' && state.loseSend) throw new Error('native response lost');
      if (state.missing) return Response.json({ jsonrpc: '2.0', id: body.id, error: { code: -32001, message: 'Task not found' } });
      const task = { id: state.taskId, contextId: 'native-context', status: { state: state.phase,
        message: { role: 'ROLE_AGENT', messageId: 'status', parts: [{ text: 'status-only text' }] } },
        artifacts: state.phase === 'TASK_STATE_COMPLETED' ? [{ artifactId: 'original', parts: [{ text: 'Original result' }] }] : [],
        history: [{ role: 'ROLE_USER', messageId: 'private', parts: [{ text: 'private prior prompt' }] }] };
      return Response.json({ jsonrpc: '2.0', id: body.id, result: body.method === 'SendMessage' ? { task } : task });
    } });
  return { adapter, calls, card, state };
}
const work = () => ({ id: randomUUID(), context_id: randomUUID(), request: { message: 'Bounded task' } });

for (const Adapter of [HermesRuntimeAdapter, OpenClawRuntimeAdapter]) {
  test(`${Adapter.name}: native task and same-handle recovery retain normal runtime identity`, async () => {
    const f = fixture(Adapter), w = work();
    const ready = await f.adapter.probe();
    assert.equal(ready.capabilities.cancel, false);
    const started = await f.adapter.start(w, w.id);
    assert.equal(started.state, 'working');
    assert.equal(f.calls[0].params.message.messageId, w.id);
    assert.equal(f.calls[0].params.message.contextId, 'envar-' + w.context_id);
    assert.equal(f.calls[0].params.configuration.returnImmediately, true);
    f.state.phase = 'TASK_STATE_COMPLETED';
    const completed = await f.adapter.observe(started.reference);
    assert.equal(completed.state, 'completed');
    assert.equal(completed.text, 'Original result');
    assert.ok(!JSON.stringify(completed).includes('private prior prompt'));
    assert.deepEqual(f.calls.map(call => call.method), ['SendMessage', 'GetTask']);
    assert.equal(f.calls[1].params.id, 'native-original');
    await assert.rejects(f.adapter.cancel(started.reference, randomUUID()), /cannot confirm/);
    assert.equal(f.calls.length, 2);
  });
}
test('native restart losing task state remains unknown without another SendMessage', async () => {
  const f = fixture(OpenClawRuntimeAdapter), w = work();
  const started = await f.adapter.start(w, w.id);
  f.state.missing = true;
  await assert.rejects(f.adapter.observe(started.reference), RuntimeOutcomeUnknown);
  assert.deepEqual(f.calls.map(call => call.method), ['SendMessage', 'GetTask']);
});
test('lost native POST is never automatically replayed', async () => {
  const f = fixture(HermesRuntimeAdapter), w = work(); f.state.loseSend = true;
  await assert.rejects(f.adapter.start(w, w.id), RuntimeOutcomeUnknown);
  assert.equal(f.calls.filter(call => call.method === 'SendMessage').length, 1);
});
test('changed reference or Card origin cannot redirect the native credential', async () => {
  const f = fixture(HermesRuntimeAdapter), w = work();
  const started = await f.adapter.start(w, w.id);
  await assert.rejects(f.adapter.observe({ ...started.reference, adapter: 'openclaw' }), RuntimeOutcomeUnknown);
  f.card.supportedInterfaces[0].url = 'https://other.example/a2a';
  await assert.rejects(f.adapter.observe(started.reference), RuntimeOutcomeUnknown);
  assert.equal(f.calls.length, 1);
});
