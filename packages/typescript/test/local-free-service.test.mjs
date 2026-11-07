import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { runDemo } from '../examples/local-free-service/demo.mjs';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
function assertSavedProof(proof, directory) {
  assert.equal(proof.capability_executions, 1);
  assert.equal(proof.paid_operations, 0);
  assert.equal(proof.message_id, 'local-free-service-original-v1');
  assert.equal(proof.task_id, proof.replay_task_id);
  assert.equal(proof.task_id, proof.restarted_get_task_id);
  assert.equal(proof.task_id, proof.restarted_replay_task_id);
  assert.equal(proof.server_processes.length, 2);
  assert.notEqual(proof.server_processes[0], proof.server_processes[1]);
  assert.match(proof.scope, /Completed result/);
  const executions = readFileSync(join(directory, 'executions.jsonl'), 'utf8').trim().split('\n');
  assert.equal(executions.length, 1, 'The private capability actually ran once across both server processes');
  for (const name of ['seller', 'runtime']) {
    const db = new DatabaseSync(join(directory, name + '.sqlite3'), { readOnly: true });
    try {
      const orders = db.prepare('SELECT task_id, message_id, payment_state, execution_state FROM commerce_orders').all();
      assert.equal(orders.length, 1);
      assert.equal(orders[0].message_id, proof.message_id);
      assert.equal(orders[0].payment_state, 'not_required');
      assert.equal(orders[0].execution_state, 'completed');
      if (name === 'seller') assert.equal(orders[0].task_id, proof.task_id);
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM commerce_payment_attempts').get().count, 0);
    } finally { db.close(); }
  }
}

test('local free example uses real HTTP and preserves one completed Task across process restart', { timeout: 45000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'envarpay-free-source-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const proof = await runDemo(directory);
  assertSavedProof(proof, directory);
  const rerun = await runDemo(directory);
  assert.equal(rerun.task_id, proof.task_id, 'Rerunning the documented command keeps the original result');
  assertSavedProof(rerun, directory);
});

function npm(args, options) {
  const cli = process.env.npm_execpath;
  return execFileSync(cli ? process.execPath : 'npm', cli ? [cli, ...args] : args,
    { ...options, encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024 });
}

test('packed npm artifact includes and runs the same local free example offline', { timeout: 90000 }, t => {
  const directory = mkdtempSync(join(tmpdir(), 'envarpay-free-package-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  // npm test already built dist. Skip prepack here so this check never recurses into a release/test hook.
  npm(['pack', '--ignore-scripts', '--silent', '--pack-destination', directory], { cwd: packageRoot });
  const packed = readdirSync(directory).filter(name => name.endsWith('.tgz'));
  assert.equal(packed.length, 1);
  npm(['install', '--offline', '--cache', join(directory, 'empty-cache'), '--ignore-scripts',
    '--no-audit', '--no-fund', '--prefix', directory, join(directory, packed[0])],
  { cwd: directory });
  const entry = join(directory, 'node_modules', '@envarai', 'envarpay', 'examples', 'local-free-service', 'demo.mjs');
  assert.ok(existsSync(entry), 'The installed package must include the actual documented example entry point');
  const state = join(directory, 'state');
  const stdout = execFileSync(process.execPath, [entry, '--state-dir', state], {
    cwd: directory, encoding: 'utf8', timeout: 45000, maxBuffer: 1024 * 1024,
  });
  const proof = JSON.parse(stdout);
  assertSavedProof(proof, state);
  const credentials = JSON.parse(readFileSync(join(state, 'tokens.json'), 'utf8'));
  assert.ok(!stdout.includes(credentials.buyer) && !stdout.includes(credentials.runtime),
    'The example output must not disclose either local token');
});
