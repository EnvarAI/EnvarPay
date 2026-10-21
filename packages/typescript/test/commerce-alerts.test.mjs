import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { CommerceStore } from '../dist/commerce/store.js';
import { EnvarIntegration } from '../dist/commerce/envar.js';
import { inspectLocalAlerts } from '../dist/commerce/operations.js';
import { loadCommerceConfig, buildQuote } from '../dist/commerce/index.js';

const rule = (report, name) => report.signals.find(signal => signal.name === name);
function integration(directory, fetchImpl = async () => Response.json({ accepted: true })) {
  return new EnvarIntegration({ policy: { enabled: true, platformOrigin: 'https://envar.example', agentId: randomUUID(), runtimeAgentId: 'local', acceptUpdates: false, allowedServices: [], allowedUpstreamOrigins: [], allowedBalanceAccounts: [] },
    stateDirectory: join(directory, 'integration'), configDirectory: join(directory, 'config'), token: () => 'dedicated-test-token-long-enough-for-validation', fetch: fetchImpl });
}
function command(path, ...args) {
  return spawnSync(process.execPath, [new URL('../dist/commerce/cli.js', import.meta.url).pathname, 'inspect', '--state', path, '--alerts', ...args], { encoding: 'utf8' });
}

test('seller alert inspection reports an unknown balance claim without reading a provider or changing the ledger', () => {
  const directory = mkdtempSync(join(tmpdir(), 'envar-alert-balance-'));
  const path = join(directory, 'seller.sqlite3');
  const store = new CommerceStore(path);
  try {
    const config = loadCommerceConfig(JSON.parse(readFileSync(new URL('../examples/seller.json', import.meta.url), 'utf8')));
    const input = { topic: 'private prompt', competitors: ['A'] };
    const order = store.ensureQuote(buildQuote(config, { serviceId: 'research', offerId: 'balance-once', caller: 'private caller', messageId: 'original', input }), input);
    store.recordSettlement(store.reservePayment(order.id, order.caller, 'original-payment', 'private-vault-reference'), 'unknown', {});
    const ambient = globalThis.fetch;
    globalThis.fetch = () => { throw new Error('Network forbidden during local inspection'); };
    let result;
    try { result = inspectLocalAlerts(path, { integrationDisabled: true }); }
    finally { globalThis.fetch = ambient; }
    assert.equal(result.role, 'seller');
    assert.equal(rule(result, 'payment_unknown').count, 1);
    assert.equal(rule(result, 'report_backlog').status, 'not_applicable');
    assert.equal(result.recommendedExitCode, 2);
    assert.equal(JSON.stringify(result).includes('private'), false);
    assert.equal(store.getOrder(order.id, order.caller).paymentState, 'unknown');
    const cli = command(path, '--no-integration', '--fail-on-alert');
    assert.equal(cli.status, 2, cli.stderr);
    assert.deepEqual(JSON.parse(cli.stdout), result);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('integration outbox alerts count original pending reports and failed delivery without flushing during inspection', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'envar-alert-outbox-'));
  const path = join(directory, 'seller.sqlite3');
  const store = new CommerceStore(path);
  let calls = 0;
  const platform = integration(directory, async () => { calls++; throw new Error('private transport error'); });
  try {
    const integrationPath = join(directory, 'integration', 'integration.sqlite');
    platform.enqueueStatus('original-report', { orderId: randomUUID(), kind: 'execution_unknown' });
    let result = inspectLocalAlerts(path, { integrationPath });
    assert.equal(rule(result, 'report_backlog').count, 1);
    assert.equal(rule(result, 'report_failure').count, 0);
    assert.equal(calls, 0);
    await platform.flush();
    result = inspectLocalAlerts(path, { integrationPath });
    assert.equal(rule(result, 'report_failure').count, 1);
    assert.equal(calls, 1);
    assert.equal(JSON.stringify(result).includes('private'), false);
    const cli = command(path, '--integration-state', integrationPath, '--fail-on-alert');
    assert.equal(cli.status, 2, cli.stderr);
  } finally { platform.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('missing, symlinked, or invalid seller ledgers report unavailable', () => {
  const directory = mkdtempSync(join(tmpdir(), 'envar-alert-invalid-'));
  const path = join(directory, 'invalid.sqlite3');
  try {
    writeFileSync(path, 'private invalid content', { mode: 0o600 });
    for (const source of [join(directory, 'missing'), path]) {
      const result = inspectLocalAlerts(source);
      assert.equal(result.status, 'unavailable');
      assert.equal(result.recommendedExitCode, 3);
      assert.equal(JSON.stringify(result).includes('private'), false);
    }
    symlinkSync(path, join(directory, 'link'));
    assert.equal(inspectLocalAlerts(join(directory, 'link')).role, 'unavailable');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
