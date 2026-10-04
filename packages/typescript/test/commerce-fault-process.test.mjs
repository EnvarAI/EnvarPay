import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Task, TaskState } from '@a2a-js/sdk';
import { ServerCallContext } from '@a2a-js/sdk/server';
import { CommerceStore } from '../dist/commerce/store.js';
import { CommerceServer } from '../dist/commerce/server.js';
import { BuyerStore } from '../dist/commerce/buyer-store.js';
import { CredentialVault } from '../dist/commerce/vault.js';
import { buildQuote, loadCommerceConfig, digest } from '../dist/commerce/index.js';

// Real OS SIGKILL + disk/WAL + product-store/vault tests. All authorizations,
// settlement receipts and executors are synthetic; no chain, PSP or model runs.
const caller = 'fixture-owner', tenant = 'research:1';
const remoteId = 'original-remote-task', remoteContext = 'original-remote-context';
const remoteInterface = 'http://runtime.invalid/a2a';
const output = 'Original fixture result retained after process loss';
const nonce = '0x' + '7'.repeat(64);
const receipt = { success: true, network: 'eip155:84532', payer: '0x' + '1'.repeat(40), transaction: '0x' + '5'.repeat(64) };
const input = { topic: 'synthetic recovery exercise', competitors: ['fixture'] };
const ctx = () => new ServerCallContext({ user: { isAuthenticated: true, userName: caller }, tenant, requestedVersion: '1.0' });
const configAt = directory => loadCommerceConfig(JSON.parse(readFileSync(join(directory, 'seller.json'), 'utf8')));
const manifestAt = directory => JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function fixtureConfig() {
  const config = loadCommerceConfig(JSON.parse(readFileSync(new URL('../examples/seller.json', import.meta.url), 'utf8')));
  config.services = config.services.filter(service => service.id === 'research');
  config.services[0].offers = config.services[0].offers.filter(offer => offer.id === 'usdc-once');
  config.services[0].offers[0].pricing.amount = '100';
  config.services[0].execution.cardUrl = 'http://runtime.invalid/agent-card.json';
  delete config.paymentProfiles['stripe-usd'];
  return loadCommerceConfig(config);
}

function savePrivate(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flush: true });
}

function syntheticBuyer(directory, manifest, completed) {
  const config = configAt(directory), service = config.services[0];
  const currency = manifest.quote.currency;
  const policy = {
    policyVersion: 1, paymentsEnabled: false, approval: 'per_purchase',
    peers: [{ id: 'fixture-seller', cardUrl: 'https://seller.invalid/agent-card.json', protocol: 'x402', currency, recipient: manifest.quote.recipient, maxPerPurchase: '100' }],
    budgets: [{ currency, maxTotal: '100', period: 'cumulative' }],
  };
  savePrivate(join(directory, 'buyer-policy.json'), policy);
  const store = new BuyerStore(join(directory, 'buyer.sqlite3'));
  const vault = new CredentialVault(join(directory, 'buyer-authorizations'), readFileSync(join(directory, 'vault.key')));
  const record = store.insert({
    caller, protocol: 'x402', peerId: 'fixture-seller', cardUrl: policy.peers[0].cardUrl,
    endpoint: 'https://seller.invalid/a2a', messageId: manifest.orderId,
    fingerprint: digest({ messageId: manifest.orderId, input }), input, inputSchema: service.contract.inputSchema,
    body: JSON.stringify({ jsonrpc: '2.0', id: 'original-rpc', method: 'SendMessage', params: { message: { messageId: manifest.orderId, role: 'ROLE_USER', parts: [{ data: input }] } } }),
    quoteToken: 'synthetic-quote-token-do-not-use',
    quote: { ...manifest.quote, messageId: manifest.orderId, payer: receipt.payer },
  });
  store.reserve(record.id, caller, policy);
  const credentialRef = vault.put({ fixture: true, nonce, originalPurchaseId: record.id, signature: 'synthetic-buyer-signature' });
  store.update(record.id, { credentialRef, nonce, state: 'submitted', paymentState: 'unknown' });
  if (completed) {
    store.confirmed(record.id, receipt);
    store.update(record.id, { state: 'completed', executionState: 'completed', task: Task.toJSON(completedTask(manifest.taskId, manifest.contextId)), result: { output } });
  }
  return { store, record, credentialRef };
}

function completedTask(id, contextId) {
  return Task.fromJSON({ id, contextId, status: { state: 'TASK_STATE_COMPLETED' }, artifacts: [{ artifactId: 'original-artifact', parts: [{ text: output }] }] });
}

async function childMain(checkpoint, directory) {
  const config = fixtureConfig();
  savePrivate(join(directory, 'seller.json'), config);
  writeFileSync(join(directory, 'vault.key'), Buffer.alloc(32, 7), { mode: 0o600, flush: true });
  savePrivate(join(directory, 'upstream-bindings.json'), { fixture: true, origin: config.services[0].execution.cardUrl, token: 'synthetic-runtime-token' });
  const store = new CommerceStore(join(directory, 'seller.sqlite3'));
  const vault = new CredentialVault(join(directory, 'authorizations'), readFileSync(join(directory, 'vault.key')));
  store.registerCatalog(config);
  const quote = buildQuote(config, { caller, serviceId: 'research', offerId: 'usdc-once', messageId: 'original-business-request', input });
  const order = store.ensureQuote(quote, input);
  const originalAuthorization = { fixture: true, nonce, quoteId: quote.quoteId, signature: 'synthetic-seller-authorization', inputDigest: quote.inputDigest };
  const credentialRef = vault.put(originalAuthorization);
  const attemptId = store.reservePayment(order.id, caller, digest({ network: receipt.network, payer: receipt.payer, nonce }), credentialRef);
  assert.equal(store.claimReady(), undefined, 'unconfirmed payment cannot dispatch');
  assert.equal(await store.load(order.taskId, ctx()), undefined, 'unconfirmed payment cannot publish a Task');
  const manifest = { checkpoint, orderId: order.id, taskId: order.taskId, attemptId, credentialRef, nonce, quote, authorizationDigest: digest(originalAuthorization), contextId: '' };
  if (checkpoint !== 'reserved' && checkpoint !== 'buyer-reserved') {
    const task = store.recordSettlement(attemptId, 'confirmed', receipt);
    manifest.contextId = task.contextId;
    if (checkpoint !== 'confirmed') {
      assert.equal(store.claimReady().id, order.id);
      if (checkpoint === 'remote' || checkpoint === 'completed') {
        store.recordRemoteTask(order.id, config.services[0].execution.cardUrl, remoteId, remoteContext, remoteInterface);
        await store.save(checkpoint === 'completed' ? completedTask(task.id, task.contextId) : Task.fromJSON({ id: task.id, contextId: task.contextId, status: { state: 'TASK_STATE_WORKING' } }), ctx());
      }
    }
  }
  if (checkpoint === 'completed' || checkpoint === 'buyer-reserved') {
    const buyer = syntheticBuyer(directory, manifest, checkpoint === 'completed');
    manifest.buyerPurchaseId = buyer.record.id;
    manifest.buyerCredentialRef = buyer.credentialRef;
    // Deliberately retain this live ownership lock until the parent SIGKILLs us.
    globalThis.fixtureBuyerStore = buyer.store;
  }
  savePrivate(join(directory, 'manifest.json'), manifest);
  const hold = setInterval(() => {}, 1000);
  process.once('disconnect', () => { clearInterval(hold); process.exit(2); });
  process.send({ checkpoint, orderId: order.id, taskId: order.taskId });
}

async function killAt(checkpoint, directory) {
  const child = fork(fileURLToPath(import.meta.url), [checkpoint, directory], {
    execPath: process.execPath, execArgv: [],
    env: { ...process.env, ENVAR_FAULT_CHILD: '1' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-8192); });
  const exited = once(child, 'exit');
  try {
    const message = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Checkpoint ${checkpoint} not reached: ${stderr}`)), 15000);
      child.once('message', value => { clearTimeout(timeout); resolve(value); });
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', (code, signal) => { clearTimeout(timeout); reject(new Error(`Child exited before checkpoint (${code}/${signal}): ${stderr}`)); });
    });
    assert.equal(message.checkpoint, checkpoint);
    assert.throws(() => new CommerceStore(join(directory, 'seller.sqlite3')), { code: 'store_locked' });
    if (checkpoint === 'buyer-reserved' || checkpoint === 'completed') assert.throws(() => new BuyerStore(join(directory, 'buyer.sqlite3')), { code: 'store_locked' });
    assert.equal(child.kill('SIGKILL'), true);
    const [code, signal] = await exited;
    assert.equal(code, null); assert.equal(signal, 'SIGKILL');
    return manifestAt(directory);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
  }
}

function counts(directory) {
  const db = new DatabaseSync(join(directory, 'seller.sqlite3'), { readOnly: true });
  try {
    return Object.fromEntries(['commerce_orders', 'commerce_payment_attempts', 'commerce_tasks', 'commerce_outbox'].map(table => [table, Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n)]));
  } finally { db.close(); }
}

function assertOriginal(store, directory, manifest) {
  const order = store.getOrder(manifest.orderId, caller);
  assert.equal(order.taskId, manifest.taskId); assert.equal(order.quote.quoteId, manifest.quote.quoteId);
  assert.equal(order.messageId, 'original-business-request'); assert.deepEqual(order.input, input);
  const attempt = store.paymentForOrder(order.id);
  assert.equal(attempt.id, manifest.attemptId); assert.equal(attempt.credentialRef, manifest.credentialRef);
  const vault = new CredentialVault(join(directory, 'authorizations'), readFileSync(join(directory, 'vault.key')));
  const authorization = vault.get(attempt.credentialRef);
  assert.equal(authorization.nonce, manifest.nonce); assert.equal(digest(authorization), manifest.authorizationDigest);
  assert.equal(readFileSync(join(directory, 'authorizations', attempt.credentialRef)).includes(Buffer.from('synthetic-seller-authorization')), false);
  return order;
}

function serverFor(store, config, calls, recover = false) {
  const execute = async function* (order) {
    calls.execute++;
    assert.equal(order.paymentState, 'confirmed');
    yield completedTask(remoteId, remoteContext);
  };
  if (recover) execute.recover = async (order, service, remote) => {
    calls.read++;
    assert.equal(order.paymentState, 'confirmed');
    assert.deepEqual(remote, { origin: service.execution.cardUrl, taskId: remoteId, contextId: remoteContext, interfaceUrl: remoteInterface });
    return completedTask(remoteId, remoteContext);
  };
  return new CommerceServer({ config, store, origin: 'http://127.0.0.1:19497', authenticate: async () => caller, execute });
}

async function drained(server) {
  for (let i = 0; i < 100 && server.isRunning; i++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(server.isRunning, false, 'bounded synthetic worker must drain');
}

function filesBelow(root) {
  const files = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name), stat = lstatSync(path);
      assert.equal(stat.isSymbolicLink(), false);
      if (stat.isDirectory()) visit(path); else { assert.ok(stat.isFile()); files.push(relative(root, path)); }
    }
  }
  visit(root); return files.sort();
}

if (process.env.ENVAR_FAULT_CHILD === '1') {
  await childMain(process.argv[2], process.argv[3]);
} else {
  test('SIGKILL after durable payment reserve preserves the authorization and cannot dispatch or reserve another payment', { timeout: 20000 }, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'envar-kill-reserved-')); let store;
    try {
      const manifest = await killAt('reserved', directory);
      store = new CommerceStore(join(directory, 'seller.sqlite3'));
      const order = assertOriginal(store, directory, manifest);
      assert.equal(order.paymentState, 'settling'); assert.equal(order.executionState, 'not_started');
      assert.equal(store.recoverInterruptedDispatches(), 0); assert.equal(store.claimReady(), undefined);
      assert.equal(await store.load(order.taskId, ctx()), undefined);
      assert.throws(() => store.reservePayment(order.id, caller, 'replacement-economic-operation', manifest.credentialRef), { code: 'payment_recovery_required' });
      store.recordSettlement(manifest.attemptId, 'unknown', {});
      assert.equal(store.claimReady(), undefined);
      assert.deepEqual(counts(directory), { commerce_orders: 1, commerce_payment_attempts: 1, commerce_tasks: 0, commerce_outbox: 0 });
    } finally { store?.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  test('SIGKILL after buyer authorization persistence retains original nonce, credential and reserved budget', { timeout: 20000 }, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'envar-kill-buyer-')); let store;
    try {
      const manifest = await killAt('buyer-reserved', directory);
      store = new BuyerStore(join(directory, 'buyer.sqlite3'));
      const purchase = store.get(manifest.buyerPurchaseId, caller);
      assert.equal(purchase.state, 'unknown'); assert.equal(purchase.paymentState, 'unknown');
      assert.equal(purchase.nonce, manifest.nonce); assert.equal(purchase.credentialRef, manifest.buyerCredentialRef);
      const vault = new CredentialVault(join(directory, 'buyer-authorizations'), readFileSync(join(directory, 'vault.key')));
      assert.equal(vault.get(purchase.credentialRef).originalPurchaseId, purchase.id);
      assert.equal(vault.get(purchase.credentialRef).nonce, manifest.nonce);
      const policy = JSON.parse(readFileSync(join(directory, 'buyer-policy.json'), 'utf8'));
      assert.equal(store.reserve(purchase.id, caller, policy).fresh, false);
      assert.deepEqual(store.usage(manifest.quote.currency), { reserved: '100', spent: '0' });
      assert.throws(() => store.rejectBeforeSigning(purchase.id, caller, 'synthetic-attempt'), { code: 'authorization_may_exist' });
    } finally { store?.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  test('SIGKILL after confirmed settlement atomically preserves one task/outbox and dispatches once on restart', { timeout: 20000 }, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'envar-kill-confirmed-')); let store, server;
    try {
      const manifest = await killAt('confirmed', directory);
      store = new CommerceStore(join(directory, 'seller.sqlite3'));
      const order = assertOriginal(store, directory, manifest);
      assert.equal(order.paymentState, 'confirmed'); assert.equal(order.executionState, 'queued');
      assert.deepEqual(store.paymentForOrder(order.id).receipt, receipt);
      assert.deepEqual(counts(directory), { commerce_orders: 1, commerce_payment_attempts: 1, commerce_tasks: 1, commerce_outbox: 1 });
      assert.equal(store.recordSettlement(manifest.attemptId, 'confirmed', receipt).id, manifest.taskId);
      const calls = { execute: 0, read: 0 };
      server = serverFor(store, configAt(directory), calls); await drained(server);
      assert.equal(calls.execute, 1); assert.equal(store.getOrder(order.id, caller).executionState, 'completed');
      store.recordSettlement(manifest.attemptId, 'confirmed', receipt); server.schedule(); await drained(server);
      assert.equal(calls.execute, 1); assert.equal(store.claimReady(), undefined);
      assert.equal((await store.load(manifest.taskId, ctx())).artifacts[0].parts[0].content.value, output);
      assert.deepEqual(counts(directory), { commerce_orders: 1, commerce_payment_attempts: 1, commerce_tasks: 1, commerce_outbox: 1 });
    } finally { if (server) { server.stop(); await drained(server); } store?.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  test('SIGKILL after dispatch claim produces durable unknown without blind redispatch', { timeout: 20000 }, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'envar-kill-claimed-')); let store, server;
    try {
      const manifest = await killAt('claimed', directory);
      store = new CommerceStore(join(directory, 'seller.sqlite3'));
      assert.equal(assertOriginal(store, directory, manifest).executionState, 'dispatching');
      const calls = { execute: 0, read: 0 };
      server = serverFor(store, configAt(directory), calls, true); await drained(server);
      assert.equal(store.getOrder(manifest.orderId, caller).executionState, 'unknown');
      assert.equal(store.claimReady(), undefined); assert.equal(calls.execute, 0);
      const task = await server.recoverTask(manifest.taskId, ctx());
      assert.equal(task.id, manifest.taskId); assert.equal(task.metadata.recoveryRequired, true);
      assert.equal(task.status.state, TaskState.TASK_STATE_UNSPECIFIED); assert.equal(calls.read, 0);
      assert.equal(store.paymentForOrder(manifest.orderId).state, 'confirmed');
      assert.deepEqual(counts(directory), { commerce_orders: 1, commerce_payment_attempts: 1, commerce_tasks: 1, commerce_outbox: 1 });
    } finally { if (server) { server.stop(); await drained(server); } store?.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  test('SIGKILL after saving remote Task recovers only the exact original handle without execution', { timeout: 20000 }, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'envar-kill-remote-')); let store, server;
    try {
      const manifest = await killAt('remote', directory);
      store = new CommerceStore(join(directory, 'seller.sqlite3'));
      assertOriginal(store, directory, manifest);
      const calls = { execute: 0, read: 0 };
      server = serverFor(store, configAt(directory), calls, true); await drained(server);
      const task = await server.recoverTask(manifest.taskId, ctx());
      assert.equal(task.id, manifest.taskId); assert.equal(task.contextId, manifest.contextId);
      assert.equal(task.status.state, TaskState.TASK_STATE_COMPLETED);
      assert.equal(task.artifacts[0].parts[0].content.value, output);
      assert.equal(calls.read, 1); assert.equal(calls.execute, 0);
      await server.recoverTask(manifest.taskId, ctx());
      assert.equal(calls.read, 1); assert.equal(store.claimReady(), undefined);
      assert.equal(store.remoteTask(manifest.orderId, caller).taskId, remoteId);
      assert.deepEqual(store.paymentForOrder(manifest.orderId).receipt, receipt);
    } finally { if (server) { server.stop(); await drained(server); } store?.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  test('stopped consistent full-directory backup restores seller/buyer/vault identities and completed result without replay', { timeout: 20000 }, async () => {
    const parent = mkdtempSync(join(tmpdir(), 'envar-offline-restore-'));
    const source = join(parent, 'original'), backup = join(parent, 'backup');
    mkdirSync(source, { mode: 0o700 });
    let seller, buyer, server;
    try {
      const manifest = await killAt('completed', source);
      // Open and close after the crash to recover/checkpoint WAL, with no running
      // server, signer or provider. Copy only after every owner has closed.
      seller = new CommerceStore(join(source, 'seller.sqlite3'));
      assertOriginal(seller, source, manifest); assert.equal(seller.recoverInterruptedDispatches(), 0);
      seller.close(); seller = undefined;
      buyer = new BuyerStore(join(source, 'buyer.sqlite3'));
      assert.equal(buyer.get(manifest.buyerPurchaseId, caller).state, 'completed');
      buyer.close(); buyer = undefined;
      const sourceFiles = filesBelow(source);
      for (const file of sourceFiles) chmodSync(join(source, file), 0o600);
      const beforeHashes = Object.fromEntries(sourceFiles.map(file => [file, sha256(readFileSync(join(source, file)))]));
      // Node's recursive cp does not preserve directory mode on every host.
      // Create a private destination tree before writing any backup bytes.
      mkdirSync(backup, { mode: 0o700 });
      for (const file of sourceFiles) {
        const target = join(backup, file);
        mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
        cpSync(join(source, file), target, { preserveTimestamps: true, force: false, errorOnExist: true });
        chmodSync(target, 0o600);
      }
      assert.deepEqual(filesBelow(backup), sourceFiles);
      assert.equal(lstatSync(backup).mode & 0o077, 0);
      for (const file of sourceFiles) {
        assert.equal(lstatSync(join(backup, file)).mode & 0o077, 0);
        assert.equal(sha256(readFileSync(join(backup, file))), beforeHashes[file]);
      }
      seller = new CommerceStore(join(backup, 'seller.sqlite3'));
      assertOriginal(seller, backup, manifest);
      buyer = new BuyerStore(join(backup, 'buyer.sqlite3'));
      const purchase = buyer.get(manifest.buyerPurchaseId, caller);
      assert.equal(purchase.credentialRef, manifest.buyerCredentialRef); assert.equal(purchase.nonce, manifest.nonce);
      assert.equal(purchase.task.id, manifest.taskId); assert.deepEqual(purchase.receipt, receipt);
      assert.deepEqual(buyer.usage(manifest.quote.currency), { reserved: '0', spent: '100' });
      const vault = new CredentialVault(join(backup, 'buyer-authorizations'), readFileSync(join(backup, 'vault.key')));
      assert.equal(vault.get(purchase.credentialRef).originalPurchaseId, purchase.id);
      const calls = { execute: 0, read: 0 };
      server = serverFor(seller, configAt(backup), calls, true); await drained(server);
      const task = await server.recoverTask(manifest.taskId, ctx());
      assert.equal(task.status.state, TaskState.TASK_STATE_COMPLETED); assert.equal(task.artifacts[0].parts[0].content.value, output);
      assert.deepEqual(calls, { execute: 0, read: 0 });
      assert.equal(seller.claimReady(), undefined);
      assert.deepEqual(counts(backup), { commerce_orders: 1, commerce_payment_attempts: 1, commerce_tasks: 1, commerce_outbox: 1 });
    } finally { if (server) { server.stop(); await drained(server); } buyer?.close(); seller?.close(); rmSync(parent, { recursive: true, force: true }); }
  });
}
