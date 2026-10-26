import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { connectorMcp } from '../dist/connector/mcp.js';
import { ConnectorJournal } from '../dist/connector/state.js';

async function connect(t, scopes, api) {
  const journal = new ConnectorJournal(':memory:', { origin: 'https://envar.example', agentId: randomUUID(),
    connectionId: randomUUID(), adapter: 'hermes', cardUrl: 'http://127.0.0.1/card' });
  const server = connectorMcp(api, journal, scopes);
  const client = new Client({ name: 'native-agent', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); journal.close(); });
  return { client, journal };
}

test('native MCP only advertises explicitly granted outgoing permissions', async t => {
  const { client } = await connect(t, ['connection:read', 'work:read'], { status: async () => ({ agent_id: 'configured' }) });
  const names = (await client.listTools()).tools.map(tool => tool.name);
  assert.ok(names.includes('get_work')); assert.ok(names.includes('wait_work'));
  assert.ok(!names.includes('send_message')); assert.ok(!names.includes('complete_work'));
  assert.ok(!names.includes('confirm_order')); assert.ok(names.includes('list_spending_grants'));
  assert.ok(!names.some(name => /wallet|purchase|claim/.test(name)));
});
test('native service quote survives a lost response and keeps one original request', async t => {
  let lost = true, quotes = 0, reads = 0;
  const original = { id: randomUUID(), state: 'previewed' }, requests = [];
  const { client } = await connect(t, ['work:read', 'work:send'], {
    quoteService: async body => { quotes++; requests.push(body.message_id); if (lost) { lost = false; throw new Error('lost quote response'); } return original; },
    order: async id => { reads++; assert.equal(id, original.id); return original; },
  });
  const args = { request_id: randomUUID(), service_id: randomUUID(), offer_id: 'once', payment_method: 'envar_balance', input: { text: 'Original input' } };
  assert.equal((await client.callTool({ name: 'quote_service', arguments: args })).isError, true);
  assert.equal((await client.callTool({ name: 'quote_service', arguments: args })).structuredContent.id, original.id);
  assert.equal((await client.callTool({ name: 'quote_service', arguments: args })).structuredContent.id, original.id);
  assert.deepEqual(requests, [args.request_id, args.request_id]); assert.equal(quotes, 2); assert.equal(reads, 1);
  assert.equal((await client.callTool({ name: 'quote_service', arguments: { ...args, input: { text: 'Changed' } } })).isError, true);
  assert.equal(quotes, 2);
});
test('native confirmation returns owner approval and never retries a financial POST itself', async t => {
  let confirms = 0;
  const { client } = await connect(t, ['work:send'], { confirmOrder: async () => {
    confirms++; return { approval_required: true, approval_url: 'https://envar.example/console/orders/original', order: { state: 'previewed' } };
  } });
  const tools = (await client.listTools()).tools;
  assert.equal(tools.find(tool => tool.name === 'confirm_order').annotations.destructiveHint, true);
  const response = await client.callTool({ name: 'confirm_order', arguments: { order_id: randomUUID(), message_id: randomUUID(), quote_token: 'original-quote' } });
  assert.equal(response.structuredContent.approval_required, true); assert.equal(confirms, 1);
});
test('send replay reads the original work and changed content is rejected', async t => {
  const row = { id: randomUUID(), status: 'completed', result: { text: 'Original peer result' } };
  let sends = 0, reads = 0;
  const { client } = await connect(t, ['work:send'], { send: async () => { sends++; return row; }, get: async () => { reads++; return row; } });
  const args = { request_id: randomUUID(), target_agent_id: randomUUID(), message: 'One task' };
  assert.equal((await client.callTool({ name: 'send_message', arguments: args })).structuredContent.id, row.id);
  assert.equal((await client.callTool({ name: 'send_message', arguments: args })).structuredContent.id, row.id);
  assert.equal(sends, 1); assert.equal(reads, 1);
  const changed = await client.callTool({ name: 'send_message', arguments: { ...args, message: 'Different task' } });
  assert.equal(changed.isError, true); assert.equal(sends, 1);
});
test('lost send response retains the original request key for backend idempotency', async t => {
  const requests = [], rows = new Map(); let lost = true;
  const { client } = await connect(t, ['work:send'], { send: async (body, key) => {
    requests.push(key); if (!rows.has(key)) rows.set(key, { id: randomUUID(), status: 'queued', request: body });
    if (lost) { lost = false; throw new Error('Response lost; use the same request ID'); }
    return rows.get(key);
  } });
  const args = { request_id: randomUUID(), target_agent_id: randomUUID(), message: 'Once' };
  assert.equal((await client.callTool({ name: 'send_message', arguments: args })).isError, true);
  const recovered = await client.callTool({ name: 'send_message', arguments: args });
  assert.equal(recovered.structuredContent.id, rows.get(args.request_id).id);
  assert.deepEqual(requests, [args.request_id, args.request_id]); assert.equal(rows.size, 1);
});
test('waiting returns input-required or unknown without starting replacement work', async t => {
  let status = 'input_required', calls = 0;
  const { client } = await connect(t, ['work:read'], { get: async id => { calls++; return { id, status, result: { text: 'Which format?' } }; } });
  const args = { work_id: randomUUID(), seconds: 1 };
  assert.equal((await client.callTool({ name: 'wait_work', arguments: args })).structuredContent.status, 'input_required');
  status = 'unknown';
  assert.equal((await client.callTool({ name: 'wait_work', arguments: args })).structuredContent.status, 'unknown');
  assert.equal(calls, 2);
});
