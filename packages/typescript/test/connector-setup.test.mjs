import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse as yaml } from 'yaml';
import { configureNative, inspectNative } from '../dist/adapters/configure-native.js';
import { pairDevice } from '../dist/connector/pairing.js';
import { privateDirectory, privateJson } from '../dist/connector/files.js';

function dirs(t) {
  const root = mkdtempSync(join(tmpdir(), 'envar-native-setup-'));
  const home = join(root, 'profile'), directory = join(root, 'connector');
  privateDirectory(home); privateDirectory(directory);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, home, directory };
}
function config(framework, home) {
  const agentId = randomUUID();
  return { version: 1, origin: 'https://envar.example', agentId, connectionId: randomUUID(), framework,
    scopes: ['connection:read','work:read','work:receive','work:report'], expiresAt: new Date().toISOString(), nativeConfigured: false,
    runtime: { home, agentId: 'main', cardUrl: `http://127.0.0.1:${framework === 'hermes' ? 9900 : 18789}/.well-known/agent-card.json`,
      binary: [framework], peerName: 'envar-' + agentId, mcpName: 'envar-' + agentId } };
}
test('Hermes setup preserves native model and unrelated peers/tools with private backups', t => {
  const { home, directory } = dirs(t), c = config('hermes', home);
  writeFileSync(join(home, 'config.yaml'), 'model: owner-model\nmcp_servers:\n  other: {command: other-tool}\ngateway:\n  platforms:\n    telegram: {enabled: true}\n', { mode: 0o600 });
  writeFileSync(join(home, '.env'), 'MODEL_TOKEN=private-model-token\nA2A_PEER_TOKENS="existing:original-peer-token"\nA2A_TRUSTED_PEERS=existing\n', { mode: 0o600 });
  const native = inspectNative('hermes', { home, versionProbe: () => 'Hermes 1.2.3' });
  assert.equal(native.runtimeVersion, '1.2.3'); assert.ok(!JSON.stringify(native).includes('private-model-token'));
  configureNative(directory, c);
  const after = yaml(readFileSync(join(home, 'config.yaml'), 'utf8'));
  assert.equal(after.model, 'owner-model'); assert.equal(after.mcp_servers.other.command, 'other-tool');
  assert.equal(after.gateway.platforms.telegram.enabled, true); assert.equal(after.platforms.a2a.enabled, true);
  assert.ok(readFileSync(join(home, '.env'), 'utf8').includes('MODEL_TOKEN=private-model-token'));
  assert.ok(readFileSync(join(home, '.env'), 'utf8').includes('existing:original-peer-token'));
  assert.ok(after.mcp_servers[c.runtime.mcpName].args.includes(c.connectionId));
  const token = readFileSync(join(directory, 'native.token'), 'utf8');
  assert.equal(configureNative(directory, c), false); assert.equal(readFileSync(join(directory, 'native.token'), 'utf8'), token);
  const marker = privateJson(join(directory, 'native-binding.json')); delete marker.connectorVersion;
  writeFileSync(join(directory, 'native-binding.json'), JSON.stringify(marker), { mode: 0o600 });
  assert.equal(configureNative(directory, c), true, 'An upgraded native MCP process must be reloaded');
  for (const entry of readdirSync(join(directory, 'native-backups')))
    assert.equal(statSync(join(directory, 'native-backups', entry)).mode & 0o077, 0);
});
test('OpenClaw setup uses native A2A peer routing and MCP without changing provider credentials', t => {
  const { home, directory } = dirs(t), c = config('openclaw', home);
  writeFileSync(join(home, 'openclaw.json'), JSON.stringify({ models: { providers: { native: { apiKey: 'owner-native-key' } } },
    agents: { list: [{ id: 'main', default: true }] }, channels: { telegram: { enabled: true } }, mcp: { servers: { other: { command: 'keep' } } },
    bindings: [{ agentId: 'main', match: { channel: 'telegram' } }] }), { mode: 0o600 });
  configureNative(directory, c);
  const after = JSON.parse(readFileSync(join(home, 'openclaw.json'), 'utf8'));
  assert.equal(after.models.providers.native.apiKey, 'owner-native-key');
  assert.equal(after.mcp.servers.other.command, 'keep'); assert.equal(after.bindings.length, 2);
  assert.equal(after.bindings[1].match.peer.id, c.runtime.peerName);
  assert.match(after.channels.a2a.peers[c.runtime.peerName].token, /^\$\{ENVAR_A2A_/);
  assert.ok(!JSON.stringify(after.mcp.servers[c.runtime.mcpName]).includes('owner-native-key'));
  after.mcp.servers[c.runtime.mcpName].command = 'user-customized-tool';
  writeFileSync(join(home, 'openclaw.json'), JSON.stringify(after), { mode: 0o600 });
  assert.throws(() => configureNative(directory, c), /was edited/);
  assert.equal(JSON.parse(readFileSync(join(home, 'openclaw.json'), 'utf8')).mcp.servers[c.runtime.mcpName].command, 'user-customized-tool');
});
test('pairing persists the device secret and replays a lost exchange without printing credentials', async t => {
  const { directory } = dirs(t), agentId = randomUUID(), connectionId = randomUUID(), printed = [];
  let starts = 0, exchanges = 0, lose = true;
  const secret = 'envar_pair_' + 's'.repeat(43), token = 'envar_agent_' + 't'.repeat(64);
  const fetch = async (url, init) => {
    if (url.pathname.endsWith('/start')) { starts++; return Response.json({ pairing_id: randomUUID(), device_token: secret,
      user_code: 'ABCD-EFGH', verification_uri: 'https://envar.example/connect/device?code=ABCD-EFGH', interval: 2,
      expires_at: new Date(Date.now() + 600000).toISOString() }); }
    assert.equal(init.headers.Authorization, 'Bearer ' + secret);
    if (url.pathname.endsWith('/status')) return Response.json({ status: 'approved' });
    exchanges++; if (lose) { lose = false; throw new Error('exchange response lost'); }
    return Response.json({ version: 1, agent_id: agentId, connection_id: connectionId, framework: 'hermes',
      platform_origin: 'https://envar.example', token, scopes: ['connection:read','work:read','work:receive','work:report'], expires_at: new Date(Date.now() + 86400000).toISOString() });
  };
  const options = { origin: 'https://envar.example', agentId, framework: 'hermes', runtimeVersion: '1', directory,
    fetch, onApproval: value => printed.push(value), poll: async () => {} };
  await assert.rejects(pairDevice(options));
  const receipt = await pairDevice(options);
  assert.equal(receipt.token, token); assert.equal(starts, 1); assert.equal(exchanges, 2);
  assert.ok(!JSON.stringify(printed).includes(secret)); assert.ok(!JSON.stringify(printed).includes(token));
  assert.equal(privateJson(join(directory, 'pairing.json')).pairing.device_token, secret);
  assert.equal(statSync(join(directory, 'pairing.json')).mode & 0o077, 0);
  writeFileSync(join(directory, 'journal-preserved'), 'original work');
  await pairDevice({ ...options, fresh: true });
  assert.equal(starts, 2); assert.equal(exchanges, 3);
  assert.equal(readFileSync(join(directory, 'journal-preserved'), 'utf8'), 'original work');
});

test('OpenClaw canonical entries require an explicit choice when the roster is ambiguous', t => {
  const { home } = dirs(t);
  writeFileSync(join(home, 'openclaw.json'), JSON.stringify({ agents: { entries: { coder: {}, reviewer: {} } } }), { mode: 0o600 });
  assert.throws(() => inspectNative('openclaw', { home, versionProbe: () => '2026.10.4' }), /multiple Agents/);
  assert.equal(inspectNative('openclaw', { home, nativeAgent: 'reviewer', versionProbe: () => '2026.10.4' }).agentId, 'reviewer');
});
