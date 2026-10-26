import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConnectorJournal } from '../dist/connector/state.js';
import { ConnectorLoop } from '../dist/connector/loop.js';
import { WorkApiError } from '../dist/connector/client.js';
import { RuntimeControlUnsupported } from '../dist/adapters/a2a-runtime.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'envar-connector-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const binding = { origin: 'https://envar.example', agentId: randomUUID(), connectionId: randomUUID(), adapter: 'hermes', cardUrl: 'http://127.0.0.1:9900/card' };
  const work = { id: randomUUID(), context_id: randomUUID(), caller_agent_id: randomUUID(), target_agent_id: binding.agentId,
    connection_id: binding.connectionId, endpoint_id: null, target_name: 'Native Agent', target_handle: '', status: 'queued',
    request: { message: 'A real bounded task', tool: '', arguments: {} }, result: {}, error_code: '', remote_task_id: '',
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(), cancel_requested_at: null, deadline_at: new Date(Date.now() + 86400000).toISOString() };
  const delivery = { id: 1, kind: 'work', work, event: { status: 'queued' } };
  let claim, reference;
  const calls = { claim: [], start: 0, report: [], ack: [], nativeStart: 0, nativeRead: 0, cancel: 0 };
  const faults = { startResponseLost: false, reportResponseLost: false, nativeResponseLost: false, ackLost: false, cancelBeforeStart: false };
  const reports = new Map(); const state = { native: 'working', deliveries: [delivery] };
  const client = {
    status: async () => ({ id: binding.connectionId, agent_id: binding.agentId, mode: 'inbox', status: 'active' }),
    inbox: async () => ({ items: state.deliveries.filter(d => !calls.ack.includes(d.id)), next_cursor: null }),
    get: async () => structuredClone(work),
    claim: async (_id, key) => {
      calls.claim.push(key); claim ??= { id: key, fence: 1, lease_until: new Date(Date.now() + 120000).toISOString() };
      return { ...structuredClone(work), claim, execution_ref: {} };
    },
    start: async (_id, value, execution) => {
      assert.deepEqual(value, { id: claim.id, fence: claim.fence }); assert.equal(execution.key, work.id);
      if (faults.cancelBeforeStart) { work.status = 'canceled'; throw new WorkApiError(409, 'conflict'); }
      if (work.status === 'queued') { calls.start++; work.status = 'working'; }
      if (faults.startResponseLost) { faults.startResponseLost = false; throw new Error('response lost after durable admission'); }
      return { ...structuredClone(work), claim, execution_ref: execution };
    },
    renew: async () => ({ ...structuredClone(work), claim, execution_ref: { key: work.id } }),
    recover: async (_id, value, execution) => {
      assert.equal(value.id, claim.id); assert.equal(execution.key, work.id);
      claim.lease_until = new Date(Date.now() + 120000).toISOString();
      return { ...structuredClone(work), claim, execution_ref: execution };
    },
    report: async (_id, event) => {
      const old = reports.get(event.event_id);
      if (old) assert.deepEqual(old, event);
      else {
        reports.set(event.event_id, structuredClone(event)); calls.report.push(structuredClone(event));
        work.status = { progress: 'working', outcome_unknown: 'unknown', cancel_confirmed: 'canceled' }[event.kind] ?? event.kind;
        if (event.kind === 'completed') work.result = { text: event.text };
      }
      if (faults.reportResponseLost) { faults.reportResponseLost = false; throw new Error('report receipt lost'); }
      return structuredClone(work);
    },
    acknowledge: async id => { if (faults.ackLost) { faults.ackLost = false; throw new Error('ack lost'); } calls.ack.push(id); },
  };
  const runtime = {
    key: 'hermes', probe: async () => ({ adapter: 'hermes', runtimeVersion: 'test', capabilities: { recover: true, input: false, cancel: false } }),
    start: async (value, key) => {
      calls.nativeStart++; assert.equal(value.id, work.id); assert.equal(key, work.id);
      if (faults.nativeResponseLost) throw new Error('native POST response lost');
      reference = { adapter: 'hermes', version: 1, value: { task: 'native-original', context: work.context_id } };
      return { reference, state: state.native, text: 'Original native result' };
    },
    observe: async value => {
      calls.nativeRead++; assert.deepEqual(value, reference);
      return { reference, state: state.native, text: 'Original native result' };
    },
    cancel: async () => { calls.cancel++; throw new RuntimeControlUnsupported(); },
    provideInput: async () => { throw new RuntimeControlUnsupported(); }, close: async () => {},
  };
  const path = join(dir, 'connector.sqlite3');
  let journal = new ConnectorJournal(path, binding), loop = new ConnectorLoop(client, runtime, journal);
  t.after(() => journal.close());
  return { binding, work, delivery, calls, faults, state, client, runtime, path,
    get journal() { return journal; }, get loop() { return loop; },
    reopen() { journal.close(); journal = new ConnectorJournal(path, binding); loop = new ConnectorLoop(client, runtime, journal); },
  };
}

test('restart observes the original native handle and completion report is idempotent', async t => {
  const f = fixture(t); await f.loop.tick();
  assert.equal(f.calls.nativeStart, 1); assert.equal(f.journal.get(f.work.id).phase, 'running');
  f.reopen(); f.state.native = 'completed'; f.faults.reportResponseLost = true;
  await assert.rejects(f.loop.tick());
  const pending = f.journal.get(f.work.id).pendingReport;
  assert.equal(pending.kind, 'completed');
  f.reopen(); await f.loop.tick();
  assert.equal(f.calls.nativeStart, 1); assert.equal(f.calls.nativeRead, 1);
  assert.equal(f.calls.report.filter(e => e.kind === 'completed').length, 1);
  assert.equal(f.journal.get(f.work.id).phase, 'terminal');
  assert.equal(f.journal.get(f.work.id).observation.text, 'Original native result');
  assert.ok(f.calls.ack.includes(1));
  assert.equal(statSync(f.path).mode & 0o077, 0);
});
test('lost admission response is retried with the same claim before one native dispatch', async t => {
  const f = fixture(t); f.faults.startResponseLost = true;
  await assert.rejects(f.loop.tick()); assert.equal(f.calls.nativeStart, 0);
  const key = f.journal.get(f.work.id).claimRequestId;
  f.reopen(); await f.loop.tick();
  assert.equal(f.calls.start, 1); assert.equal(f.calls.nativeStart, 1);
  assert.equal(f.journal.get(f.work.id).claimRequestId, key);
});
test('lost native POST stays unknown across restarts with no repeated model task', async t => {
  const f = fixture(t); f.faults.nativeResponseLost = true;
  await f.loop.tick(); assert.equal(f.journal.get(f.work.id).phase, 'unknown');
  f.reopen(); await f.loop.tick(); await f.loop.tick();
  assert.equal(f.calls.nativeStart, 1); assert.equal(f.calls.nativeRead, 0);
  assert.equal(f.calls.report.filter(e => e.kind === 'outcome_unknown').length, 1);
});
test('interrupted native dispatch marker cannot be turned back into a fresh dispatch', async t => {
  const f = fixture(t); f.journal.ingest(f.delivery);
  const record = f.journal.get(f.work.id); const claimed = await f.client.claim(f.work.id, record.claimRequestId);
  record.claim = claimed.claim; await f.client.start(f.work.id, { id: claimed.claim.id, fence: 1 }, { key: f.work.id });
  record.phase = 'dispatching'; f.journal.save(record); f.reopen(); await f.loop.tick();
  assert.equal(f.calls.nativeStart, 0); assert.equal(f.journal.get(f.work.id).phase, 'unknown');
});
test('cancellation between claim and start never reaches the native runtime', async t => {
  const f = fixture(t); f.faults.cancelBeforeStart = true;
  await f.loop.tick(); assert.equal(f.calls.nativeStart, 0); assert.equal(f.journal.get(f.work.id).phase, 'terminal');
});
test('unacknowledged control is not invoked twice after restart', async t => {
  const f = fixture(t); await f.loop.tick();
  f.state.deliveries.push({ id: 2, kind: 'cancel', work: structuredClone(f.work), event: {} });
  f.faults.ackLost = true;
  await assert.rejects(f.loop.tick()); assert.equal(f.calls.cancel, 1);
  f.reopen(); await f.loop.tick(); assert.equal(f.calls.cancel, 1); assert.ok(f.calls.ack.includes(2));
});
test('result delivery is durable before ack and is never executed as new work', async t => {
  const f = fixture(t);
  const result = { ...structuredClone(f.work), id: randomUUID(), caller_agent_id: f.binding.agentId,
    target_agent_id: randomUUID(), connection_id: randomUUID(), status: 'completed', result: { text: 'Peer result' } };
  f.state.deliveries = [{ id: 8, kind: 'result', work: result, event: { status: 'completed' } }];
  await f.loop.tick(); f.reopen();
  assert.equal(f.calls.nativeStart, 0); assert.equal(f.journal.results()[0].work.result.text, 'Peer result');
  assert.ok(f.calls.ack.includes(8));
});
test('a private journal cannot silently bind to another Agent', t => {
  const f = fixture(t);
  assert.throws(() => new ConnectorJournal(f.path, { ...f.binding, agentId: randomUUID() }), /another Agent/);
});

test('durably observed completion survives a crash before its report is queued', async t => {
  const f = fixture(t); await f.loop.tick();
  const record = f.journal.get(f.work.id);
  record.phase = 'dispatching'; record.observation = { reference: record.reference, state: 'completed', text: 'Saved actual result' };
  f.journal.save(record); f.reopen();
  f.runtime.observe = async () => { throw new Error('native task cache was lost'); };
  await f.loop.tick();
  assert.equal(f.work.result.text, 'Saved actual result');
  assert.equal(f.calls.nativeStart, 1); assert.equal(f.calls.nativeRead, 0);
  assert.equal(f.journal.get(f.work.id).phase, 'terminal');
});
