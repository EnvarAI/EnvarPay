import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, rmSync, symlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { BuyerStore } from '../dist/commerce/buyer-store.js';
import { CommerceStore } from '../dist/commerce/store.js';
import { EnvarIntegration } from '../dist/commerce/envar.js';
import { inspectLocalAlerts } from '../dist/commerce/operations.js';
import { loadCommerceConfig, buildQuote } from '../dist/commerce/index.js';

const base = 'eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const policy = (budgets = [{ currency: 'usd', maxTotal: '1000', period: 'cumulative' }]) => ({ policyVersion: 1, paymentsEnabled: true, approval: 'per_purchase',
  peers: [{ id: 'seller', cardUrl: 'https://secret-host.example/card.json', protocol: 'mpp', currency: 'usd', recipient: 'profile_secret', maxPerPurchase: '50' }], budgets });
const rule = (report, name) => report.signals.find(s => s.name === name);
function save(path, value) { writeFileSync(path, JSON.stringify(value), { mode: 0o600 }); }
function hashes(directory) {
  // WAL reader marks are transient shared-memory coordination, not durable ledger state.
  return Object.fromEntries(readdirSync(directory, { withFileTypes: true }).filter(f => f.isFile() && !f.name.endsWith('-shm')).map(f => [f.name, createHash('sha256').update(readFileSync(join(directory, f.name))).digest('hex')]));
}
function insert(store, name, amount, currency = 'usd', paymentState = 'confirmed', executionState = 'completed', errorCode) {
  const record = store.insert({ caller: 'secret-caller', protocol: 'mpp', peerId: 'secret-peer', cardUrl: 'https://secret.example/card', endpoint: 'https://secret.example/a2a', messageId: name, fingerprint: name,
    input: { secret: 'secret prompt' }, inputSchema: {}, body: 'secret-body', quoteToken: 'secret-quote-token',
    quote: { messageId: name, payer: 'secret-payer', amount, currency, recipient: 'profile_secret', expiresAt: new Date(Date.now() + 300000).toISOString(), serviceId: 'service', serviceRevision: 1, offerId: 'offer', inputDigest: 'digest', termsDigest: 'terms', quoteId: name } });
  store.reserve(record.id, record.caller, policy([{ currency, maxTotal: '99999999999999999999', period: 'cumulative' }]));
  if (paymentState === 'confirmed') store.confirmed(record.id, { method: 'stripe', reference: 'pi_secret', secret: 'secret receipt' });
  store.update(record.id, { state: paymentState === 'confirmed' ? 'completed' : 'unknown', paymentState, executionState, errorCode, credentialRef: 'secret vault reference' });
  return record;
}
function integration(directory, fetchImpl = async () => Response.json({ accepted: true })) {
  return new EnvarIntegration({ policy: { enabled: true, platformOrigin: 'https://secret-envar.example', agentId: randomUUID(), runtimeAgentId: 'local', acceptUpdates: false, allowedServices: [], allowedUpstreamOrigins: [], allowedX402: [], allowedMppAccounts: [] },
    stateDirectory: join(directory, 'integration'), configDirectory: join(directory, 'config'), token: () => 'secret-token-that-stays-private-long-enough', fetch: fetchImpl });
}
function command(path, ...args) { return spawnSync(process.execPath, [new URL('../dist/commerce/cli.js', import.meta.url).pathname, 'inspect', '--state', path, '--alerts', ...args], { encoding: 'utf8' }); }

test('local buyer alerts use BigInt budgets, preserve unknown reservations and disclose only finite aggregate fields', () => {
  const directory = mkdtempSync(join(tmpdir(), 'envar-alert-budget-')), path = join(directory, 'buyer.sqlite3'), configPath = join(directory, 'policy.json');
  const store = new BuyerStore(path); let platform;
  try {
    insert(store, 'spent-usd', '900'); insert(store, 'pending-usd', '50', 'usd', 'unknown', 'unknown', 'stripe_rate_limit');
    insert(store, 'spent-base', '9007199254740992', base); insert(store, 'pending-base', '1', base, 'unknown', 'completed', 'untrusted-secret-error');
    save(configPath, policy([{ currency: 'usd', maxTotal: '1000', period: 'cumulative' }, { currency: base, maxTotal: '9007199254740993', period: 'cumulative' }]));
    platform = integration(directory); const integrationPath = join(directory, 'integration', 'integration.sqlite');
    const before = hashes(directory), beforeIntegration = hashes(join(directory, 'integration'));
    const ambient = globalThis.fetch; globalThis.fetch = () => { throw new Error('Network forbidden during local inspection'); };
    let report;
    try { report = inspectLocalAlerts(path, { policyPath: configPath, integrationPath }); } finally { globalThis.fetch = ambient; }
    assert.equal(report.status, 'available'); assert.equal(report.role, 'buyer'); assert.equal(report.recommendedExitCode, 2);
    assert.equal(rule(report, 'payment_unknown').count, 2); assert.equal(rule(report, 'execution_unknown').count, 1); assert.equal(rule(report, 'recorded_provider_failure').count, 1);
    assert.equal(rule(report, 'budget_near_limit').count, 1); assert.equal(rule(report, 'budget_exhausted').severity, 'critical');
    assert.deepEqual(report.budgets, [{ unit: 'usd_cents', maxTotal: '1000', reserved: '50', spent: '900', remaining: '50', state: 'near_limit' },
      { unit: 'base_usdc_atomic', maxTotal: '9007199254740993', reserved: '1', spent: '9007199254740992', remaining: '0', state: 'exhausted' }]);
    assert.equal(report.providerHealth, 'unavailable_not_probed'); assert.equal(report.paymentPerformed, false); assert.equal(report.networkRequests, 0);
    assert.deepEqual(store.usage('usd'), { spent: '900', reserved: '50' }); assert.deepEqual(hashes(directory), before); assert.deepEqual(hashes(join(directory, 'integration')), beforeIntegration);
    const text = JSON.stringify(report); for (const value of ['secret', 'http', 'profile_', 'pi_', '0x', 'caller', 'credential', 'eventId']) assert.equal(text.includes(value), false, value);
    const cli = command(path, '--config', configPath, '--integration-state', integrationPath, '--fail-on-alert');
    assert.equal(cli.status, 2, cli.stderr); assert.deepEqual(JSON.parse(cli.stdout), report); assert.deepEqual(hashes(directory), before);
  } finally { platform?.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('exact 90 percent threshold, unspent allowance and over-limit policies never round through Number', () => {
  const directory = mkdtempSync(join(tmpdir(), 'envar-alert-threshold-')), path = join(directory, 'buyer.sqlite3'), configPath = join(directory, 'policy.json'), store = new BuyerStore(path);
  try {
    const record = insert(store, 'threshold', '9007199254740993');
    const maximum = 10007999171934437n; // value*10 is three below max*9.
    save(configPath, policy([{ currency: 'usd', maxTotal: maximum.toString(), period: 'cumulative' }]));
    assert.equal(inspectLocalAlerts(path, { policyPath: configPath }).budgets[0].state, 'available');
    save(configPath, policy([{ currency: 'usd', maxTotal: (maximum - 1n).toString(), period: 'cumulative' }]));
    assert.equal(inspectLocalAlerts(path, { policyPath: configPath }).budgets[0].state, 'near_limit');
    save(configPath, policy([{ currency: 'usd', maxTotal: '50', period: 'cumulative' }]));
    const over = inspectLocalAlerts(path, { policyPath: configPath }); assert.equal(over.budgets[0].remaining, '0'); assert.equal(over.budgets[0].state, 'exhausted');
    assert.equal(store.get(record.id, 'secret-caller').paymentState, 'confirmed');
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('real integration outbox supplies pending and failed delivery alerts without flushing or emitting private payloads', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'envar-alert-report-')), path = join(directory, 'seller.sqlite3'), store = new CommerceStore(path); let calls = 0;
  const platform = integration(directory, async () => { calls++; throw new Error('secret transport'); });
  try {
    const integrationPath = join(directory, 'integration', 'integration.sqlite');
    const empty = inspectLocalAlerts(path, { integrationPath });
    assert.equal(empty.alertCount, 0); assert.equal(empty.unavailableCount, 0); assert.equal(empty.recommendedExitCode, 0);
    platform.enqueueStatus('secret-dedupe', { orderId: randomUUID(), kind: 'execution_unknown' });
    const pending = inspectLocalAlerts(path, { integrationPath });
    assert.equal(rule(pending, 'report_backlog').count, 1); assert.equal(rule(pending, 'report_failure').count, 0); assert.equal(calls, 0);
    await platform.flush(); // Real integration behavior against an injected failed transport, not a network.
    assert.equal(calls, 1);
    const before = hashes(join(directory, 'integration')), queue = platform.queueStatus();
    const failed = inspectLocalAlerts(path, { integrationPath });
    assert.equal(rule(failed, 'report_failure').count, 1); assert.equal(rule(failed, 'report_backlog').count, 1);
    assert.equal(calls, 1); assert.deepEqual(platform.queueStatus(), queue); assert.deepEqual(hashes(join(directory, 'integration')), before);
    const text = JSON.stringify(failed); for (const marker of ['secret', queue.errors[0].eventId, platform.sourceInstance, 'platformOrigin']) assert.equal(text.includes(marker), false);
    const standalone = command(path, '--no-integration', '--fail-on-alert'); assert.equal(standalone.status, 0); assert.equal(rule(JSON.parse(standalone.stdout), 'report_failure').status, 'not_applicable');
    const cli = command(path, '--integration-state', integrationPath, '--fail-on-alert'); assert.equal(cli.status, 2); assert.deepEqual(JSON.parse(cli.stdout), failed);
    assert.deepEqual(hashes(join(directory, 'integration')), before); assert.equal(calls, 1);
  }
  finally { platform.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('missing policy or source, invalid schema and unsafe files are unavailable rather than clear', () => {
  const directory = mkdtempSync(join(tmpdir(), 'envar-alert-missing-')), path = join(directory, 'buyer.sqlite3'), store = new BuyerStore(path), configPath = join(directory, 'policy.json');
  try {
    let report = inspectLocalAlerts(path); assert.equal(rule(report, 'budget_near_limit').status, 'unavailable'); assert.equal(rule(report, 'report_backlog').status, 'unavailable'); assert.equal(report.recommendedExitCode, 3);
    save(configPath, policy()); chmodSync(configPath, 0o644); assert.equal(rule(inspectLocalAlerts(path, { policyPath: configPath }), 'budget_exhausted').status, 'unavailable'); chmodSync(configPath, 0o600);
    symlinkSync(path, join(directory, 'symlink')); report = inspectLocalAlerts(join(directory, 'symlink')); assert.equal(report.role, 'unavailable');
    report = inspectLocalAlerts(join(directory, 'missing')); assert.equal(report.role, 'unavailable'); assert.equal(report.signals.every(s => s.status === 'unavailable'), true);
    writeFileSync(join(directory, 'broken'), 'secret-corrupt-content', { mode: 0o600 }); report = inspectLocalAlerts(join(directory, 'broken')); assert.equal(report.status, 'unavailable'); assert.equal(JSON.stringify(report).includes('secret'), false);
    const cli = command(path, '--fail-on-alert'); assert.equal(cli.status, 3); assert.equal(JSON.parse(cli.stdout).status, 'partial');
    const normal = command(path); assert.equal(normal.status, 0); assert.equal(JSON.parse(normal.stdout).recommendedExitCode, 3);
    const invalid = command(path, '--refund-review'); assert.equal(invalid.status, 1); assert.match(invalid.stderr, /inspection_view/);
    const conflicting = command(path, '--no-integration', '--integration-state', 'unread-path'); assert.equal(conflicting.status, 1); assert.match(conflicting.stderr, /inspection_view/);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('seller provider failures are actual stored failed receipts; empty unknown receipts do not invent provider outage', () => {
  const directory = mkdtempSync(join(tmpdir(), 'envar-alert-seller-')), path = join(directory, 'seller.sqlite3'), store = new CommerceStore(path);
  try {
    const config = loadCommerceConfig(JSON.parse(readFileSync(new URL('../examples/seller.json', import.meta.url), 'utf8')));
    for (const [messageId, receipt] of [['failed', { success: false, errorReason: 'secret-provider-reason' }], ['unknown', {}]]) {
      const input = { topic: 'secret', competitors: ['A'] }, order = store.ensureQuote(buildQuote(config, { serviceId: 'research', offerId: 'usdc-once', caller: 'secret-owner', messageId, input }), input);
      store.recordSettlement(store.reservePayment(order.id, 'secret-owner', messageId, 'secret-vault'), 'unknown', receipt);
    }
    const before = hashes(directory), result = inspectLocalAlerts(path);
    assert.equal(rule(result, 'payment_unknown').count, 2); assert.equal(rule(result, 'recorded_provider_failure').count, 1);
    assert.equal(rule(result, 'budget_exhausted').status, 'not_applicable'); assert.equal(result.providerHealth, 'unavailable_not_probed');
    assert.equal(JSON.stringify(result).includes('secret'), false); assert.deepEqual(hashes(directory), before);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
