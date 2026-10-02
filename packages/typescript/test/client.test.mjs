import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { WalletClient, WalletToolError, OperationUnknownError } from '../dist/index.js';

const token = 'test-wallet-token-00000000000000000000';
let processHandle, directory, url;

test('MCP initialization reports the installed package identity and version', async () => {
  const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const originalFetch = globalThis.fetch;
  let identity;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.method === 'POST') {
      const message = await request.clone().json();
      if (message.method === 'initialize') identity = message.params.clientInfo;
    }
    return originalFetch(request);
  };
  let wallet;
  try {
    wallet = await WalletClient.connect({ url, token });
    assert.deepEqual(identity, { name: metadata.name, version: metadata.version });
  } finally {
    if (wallet) await wallet.close();
    globalThis.fetch = originalFetch;
  }
});

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'envarpay-ts-'));
  processHandle = spawn(process.env.ENVARPAY_TEST_PYTHON || 'python3',
    [new URL('./wallet_fixture.py', import.meta.url).pathname, directory], { stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = '';
  processHandle.stderr.on('data', chunk => { errors += chunk; });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Fixture startup timed out: ${errors}`)), 15_000);
    processHandle.once('exit', code => { clearTimeout(timer); reject(new Error(`Fixture exited ${code}: ${errors}`)); });
    processHandle.stdout.once('data', data => { clearTimeout(timer); resolve(Number(data.toString().trim())); });
  });
  url = `http://127.0.0.1:${port}/mcp`;
  // Wait for this fixture's readiness, without resubmitting any tool call.
  for (let i = 0; i < 100; i++) {
    try { await fetch(url); return; } catch { await new Promise(r => setTimeout(r, 20)); }
  }
  throw new Error('Fixture did not become ready');
});

after(async () => {
  if (processHandle?.exitCode === null) {
    processHandle.kill('SIGTERM');
    await new Promise(resolve => processHandle.once('exit', resolve));
  }
  if (directory) await rm(directory, { recursive: true, force: true });
});

test('actual Python wallet adapter: schemas, JSON results, list wrapping and original recovery', async () => {
  const wallet = await WalletClient.connect({ url, token });
  try {
    assert.equal((await wallet.listPaidTools('approved')).tools[0].name, 'ask_agent');
    const original = await wallet.callPaidTool({ peer: 'approved', tool: 'ask_agent', arguments: { question: 'hello' }, requestId: 'original' });
    assert.equal(original.payment_made, false);
    assert.equal(JSON.parse(original.result.content[0].text).question, 'hello');
    assert.equal((await wallet.paymentStatus('original'))[0].status, 'completed');
    assert.deepEqual(await wallet.recoverPayment('original'), original);
    assert.equal(JSON.parse(await readFile(join(directory, 'calls.json'), 'utf8')).original, 1);
    await assert.rejects(wallet.listPaidTools('unapproved'), WalletToolError);
    await assert.rejects(wallet.callPaidTool({ peer: 'approved', tool: 'refused', arguments: {}, requestId: 'refused' }), error => error instanceof WalletToolError && /Payments are disabled/.test(error.message));
  } finally { await wallet.close(); }
});

test('lost response preserves the ID and does not automatically repeat a paid call', async () => {
  const wallet = await WalletClient.connect({ url, token, timeoutMs: 60 });
  try {
    await assert.rejects(wallet.callPaidTool({ peer: 'approved', tool: 'slow', arguments: {}, requestId: 'uncertain' }),
      error => error instanceof OperationUnknownError && error.requestId === 'uncertain');
  } finally { await wallet.close(); }
  await new Promise(resolve => setTimeout(resolve, 350));
  const recovered = await WalletClient.connect({ url, token });
  try {
    assert.equal((await recovered.paymentStatus('uncertain'))[0].status, 'completed');
    assert.equal((await recovered.recoverPayment('uncertain')).request_id, 'uncertain');
    assert.equal(JSON.parse(await readFile(join(directory, 'calls.json'), 'utf8')).uncertain, 1);
  } finally { await recovered.close(); }
});

test('bearer authentication is enforced by the actual Python wallet middleware', async () => {
  await assert.rejects(WalletClient.connect({ url, token: 'wrong-token' }));
});

test('Envar catalog discovery does not authorize a new recipient or seller alias', async () => {
  const wallet = await WalletClient.connect({ url, token });
  try {
    const discovery = await wallet.discoverAgents('Research');
    assert.equal(discovery.payment_authorized, false);
    assert.equal(discovery.candidates[0].handle, 'researcher');
    assert.equal((await wallet.getAgent('researcher')).display_name, 'Research agent');
    await assert.rejects(wallet.listPaidTools('researcher'), WalletToolError);
    assert.deepEqual(await wallet.paymentStatus('not-bought'), []);
  } finally { await wallet.close(); }
});

test('a redirect cannot forward wallet authentication to another endpoint', async () => {
  let forwarded = 0;
  const target = createServer((_req, res) => { forwarded++; res.end('{}'); });
  await new Promise(resolve => target.listen(0, '127.0.0.1', resolve));
  const redirect = createServer((_req, res) => {
    res.writeHead(307, { Location: `http://127.0.0.1:${target.address().port}/mcp` }); res.end();
  });
  await new Promise(resolve => redirect.listen(0, '127.0.0.1', resolve));
  try {
    await assert.rejects(WalletClient.connect({ url: `http://127.0.0.1:${redirect.address().port}/mcp`, token }));
    assert.equal(forwarded, 0);
  } finally {
    await Promise.all([new Promise(resolve => redirect.close(resolve)), new Promise(resolve => target.close(resolve))]);
  }
});


test('reviewed Agent calls use the private wallet and retain the reviewed amount', async () => {
  const wallet = await WalletClient.connect({url, token});
  try {
    assert.equal((await wallet.walletPolicy()).payments_enabled, false);
    const input = {agentId:'approved-agent', endpointId:'approved-entry', tool:'ask_agent', arguments:{question:'reviewed'}, requestId:'reviewed-agent', expectedNetwork:'eip155:84532', expectedPayTo:'0x'+'3'.repeat(40), expectedAmountAtomic:10000};
    assert.equal((await wallet.callAgent(input)).request_id, input.requestId);
    await assert.rejects(wallet.callAgent({...input, requestId:'different-review', expectedAmountAtomic:9999}), WalletToolError);
    await assert.rejects(wallet.callAgent({...input, expectedAmountAtomic:0}), TypeError);
    assert.equal(JSON.parse(await readFile(join(directory,'calls.json'),'utf8'))[input.requestId],1);
  } finally {await wallet.close();}
});
