import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { EXPECTED_TEXT, INPUT, MESSAGE_ID, SERVICE_PATH, prepareState } from './shared.mjs';

export async function launchServer(stateDirectory) {
  const child = spawn(process.execPath, [
    fileURLToPath(new URL('./server.mjs', import.meta.url)), '--state-dir', stateDirectory,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4096); });
  const lines = createInterface({ input: child.stdout });
  let timer;
  try {
    const ready = await Promise.race([
      new Promise((resolve, reject) => {
        lines.on('line', line => {
          try { const row = JSON.parse(line); if (row.event === 'ready') resolve(row); }
          catch { reject(new Error('Example server emitted an invalid readiness record.')); }
        });
        child.once('error', reject);
        child.once('exit', code => reject(new Error('Example server exited before ready (' + code + '): ' + stderr)));
      }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Example server readiness timed out.')), 15000); }),
    ]);
    return {
      ...ready,
      async stop() {
        child.kill('SIGTERM');
        const force = setTimeout(() => child.kill('SIGKILL'), 5000);
        try {
          const [code, signal] = await closed;
          assert.equal(code, 0, 'Example shutdown failed: ' + signal + ' ' + stderr);
        } finally { clearTimeout(force); lines.close(); }
      },
    };
  } catch (error) {
    child.kill('SIGKILL');
    await closed;
    lines.close();
    throw error;
  } finally { clearTimeout(timer); }
}

export async function rpc(origin, token, method, params) {
  assert.equal(new URL(origin).hostname, '127.0.0.1');
  const response = await fetch(origin + SERVICE_PATH + '/a2a', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
    headers: {
      Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'A2A-Version': '1.0',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: method + '-local-demo', method, params }),
  });
  assert.equal(response.status, 200);
  return response.json();
}
export const message = (input = INPUT) => ({
  message: { messageId: MESSAGE_ID, role: 'ROLE_USER', parts: [{ data: input }] },
  configuration: { returnImmediately: true },
});
export function resultText(task) {
  return (task.artifacts ?? []).flatMap(a => a.parts ?? []).map(p => p.text ?? '').join('\n');
}
async function completed(origin, token, taskId) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const response = await rpc(origin, token, 'GetTask', { id: taskId });
    assert.ok(!response.error, JSON.stringify(response.error));
    if (response.result.status.state === 'TASK_STATE_COMPLETED') return response.result;
    if (response.result.status.state === 'TASK_STATE_FAILED' || response.result.metadata?.recoveryRequired) {
      throw new Error('Inspect the original demo Task; no replacement was submitted.');
    }
    await sleep(50);
  }
  throw new Error('The original demo Task is still unresolved; keep this state directory.');
}
function executionCount(directory) {
  const path = join(directory, 'executions.jsonl');
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).length : 0;
}
function inspectLedger(directory, name) {
  const db = new DatabaseSync(join(directory, name + '.sqlite3'), { readOnly: true });
  try {
    return {
      orders: db.prepare('SELECT message_id, payment_state, execution_state FROM commerce_orders').all(),
      payment_attempts: db.prepare('SELECT COUNT(*) AS count FROM commerce_payment_attempts').get().count,
      tasks: db.prepare('SELECT COUNT(*) AS count FROM commerce_tasks').get().count,
    };
  } finally { db.close(); }
}

/** Real HTTP + process restart demonstration; completed-result replay, not an in-flight recovery claim. */
export async function runDemo(directory) {
  const state = await prepareState(directory);
  let server;
  try {
    server = await launchServer(state.stateDirectory);
    const firstPid = server.pid;
    const cardResponse = await fetch(server.origin + SERVICE_PATH + '/agent-card.json', { signal: AbortSignal.timeout(10000) });
    assert.equal(cardResponse.status, 200);
    const card = await cardResponse.json();
    assert.equal(card.supportedInterfaces[0].protocolVersion, '1.0');
    const unauthorized = await fetch(server.origin + SERVICE_PATH + '/a2a', { method: 'POST', signal: AbortSignal.timeout(10000) });
    assert.equal(unauthorized.status, 401);
    const first = await rpc(server.origin, state.tokens.buyer, 'SendMessage', message());
    assert.ok(first.result?.task?.id, JSON.stringify(first.error));
    const taskId = first.result.task.id;
    const delivered = await completed(server.origin, state.tokens.buyer, taskId);
    assert.equal(resultText(delivered), EXPECTED_TEXT);
    const replay = await rpc(server.origin, state.tokens.buyer, 'SendMessage', message());
    assert.equal(replay.result.task.id, taskId);
    const conflict = await rpc(server.origin, state.tokens.buyer, 'SendMessage', message({ text: 'Changed input must not run' }));
    assert.ok(conflict.error, 'Changed input using the original message ID must be rejected.');
    assert.equal(executionCount(state.stateDirectory), 1);
    await server.stop();
    server = undefined;

    // A different OS process reopens the original SQLite stores and original auth files.
    server = await launchServer(state.stateDirectory);
    const secondPid = server.pid;
    const restored = await rpc(server.origin, state.tokens.buyer, 'GetTask', { id: taskId });
    assert.equal(restored.result.id, taskId);
    assert.equal(restored.result.status.state, 'TASK_STATE_COMPLETED');
    assert.equal(resultText(restored.result), EXPECTED_TEXT);
    const replayAfterRestart = await rpc(server.origin, state.tokens.buyer, 'SendMessage', message());
    assert.equal(replayAfterRestart.result.task.id, taskId);
    assert.equal(resultText(replayAfterRestart.result.task), EXPECTED_TEXT);
    assert.equal(executionCount(state.stateDirectory), 1);
    await server.stop();
    server = undefined;

    const seller = inspectLedger(state.stateDirectory, 'seller');
    const runtime = inspectLedger(state.stateDirectory, 'runtime');
    for (const ledger of [seller, runtime]) {
      assert.equal(ledger.orders.length, 1);
      assert.equal(ledger.orders[0].message_id, MESSAGE_ID);
      assert.equal(ledger.orders[0].payment_state, 'not_required');
      assert.equal(ledger.orders[0].execution_state, 'completed');
      assert.equal(ledger.payment_attempts, 0);
      assert.equal(ledger.tasks, 1);
    }
    const proof = {
      example: 'local-free-service', capability: 'deterministic uppercase, not AI inference',
      message_id: MESSAGE_ID, task_id: taskId,
      replay_task_id: replay.result.task.id,
      restarted_get_task_id: restored.result.id,
      restarted_replay_task_id: replayAfterRestart.result.task.id,
      server_processes: [firstPid, secondPid],
      result: EXPECTED_TEXT, capability_executions: executionCount(state.stateDirectory),
      seller, runtime, paid_operations: 0, state_directory: state.stateDirectory,
      scope: 'Completed result survives process restart. No in-flight runtime recovery, model quality, payment or production acceptance claim.',
    };
    writeFileSync(join(state.stateDirectory, 'result.json'), JSON.stringify(proof, null, 2) + '\n', { mode: 0o600, flush: true });
    return proof;
  } finally { await server?.stop(); }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const { values } = parseArgs({ options: { 'state-dir': { type: 'string' } } });
    const directory = values['state-dir'] ?? mkdtempSync(join(tmpdir(), 'envarpay-local-free-'));
    const proof = await runDemo(directory);
    console.log(JSON.stringify(proof, null, 2));
  } catch (error) {
    console.error('Local free example failed: ' + error.message);
    process.exitCode = 1;
  }
}
