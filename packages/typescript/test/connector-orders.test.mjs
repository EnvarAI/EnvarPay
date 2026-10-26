import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EnvarWorkClient } from '../dist/connector/client.js';
import { digest } from '../dist/commerce/config.js';

const token = 'envar_agent_' + 't'.repeat(43);
function fixture() {
  const request = { payment_method: 'envar_balance', service_id: randomUUID(), offer_id: 'once', input: { text: 'Original task' }, message_id: randomUUID() };
  const order = { id: randomUUID(), message_id: request.message_id, service_id: request.service_id, offer_id: 'once',
    seller_agent_id: randomUUID(), buyer_agent_id: randomUUID(), work_id: null, spending_grant_id: null,
    payment_method: 'envar_balance', state: 'previewed', payment_state: 'quoted', execution_state: 'not_started', input: request.input,
    result: {}, task: {}, last_error: '', quote: { quote_token: 'original-quote', quote_id: randomUUID(), task_id: randomUUID(), amount: '1000',
      currency: 'usd', recipient: 'envar', expires_at: new Date(Date.now() + 600000).toISOString(), terms_digest: 'a'.repeat(64), input_digest: digest(request.input) } };
  return { request, order };
}
test('service client keeps quote identity, integer money and selected origin', async () => {
  const { request, order } = fixture(), calls = [];
  const client = new EnvarWorkClient('https://envar.example', token, { fetch: async (url, init) => { calls.push({ url, init }); return Response.json(order); } });
  assert.equal((await client.quoteService(request)).id, order.id);
  assert.equal(calls[0].url.origin, 'https://envar.example');
  assert.equal(calls[0].init.headers.get('Idempotency-Key'), request.message_id);
  order.quote.amount = 0.001;
  await assert.rejects(client.quoteService(request), /Invalid Agent Work/);
  order.quote.amount = '1000'; order.quote.input_digest = 'b'.repeat(64);
  await assert.rejects(client.quoteService(request), /differs from the original/);
});
test('confirmation cannot supply replacement money terms or send approval to another site', async () => {
  const { order } = fixture(); let calls = 0, foreign = false;
  const client = new EnvarWorkClient('https://envar.example', token, { fetch: async () => {
    calls++; return Response.json({ order, approval_required: true, approval_url: `${foreign ? 'https://other.example' : 'https://envar.example'}/console/orders/${order.id}` });
  } });
  const confirmation = { quote_token: order.quote.quote_token, message_id: order.message_id };
  assert.equal((await client.confirmOrder(order.id, confirmation)).approval_required, true);
  await assert.rejects(client.confirmOrder(order.id, { ...confirmation, amount: '1' }));
  assert.equal(calls, 1);
  foreign = true;
  await assert.rejects(client.confirmOrder(order.id, confirmation), /original Envar order/);
  assert.equal(calls, 2);
});
test('a lost confirmation response is returned without creating another payment attempt', async () => {
  const { order } = fixture(); let calls = 0;
  const client = new EnvarWorkClient('https://envar.example', token, { fetch: async () => { calls++; throw new Error('Response lost after reservation'); } });
  await assert.rejects(client.confirmOrder(order.id, { quote_token: order.quote.quote_token, message_id: order.message_id, spending_grant_id: randomUUID() }));
  assert.equal(calls, 1);
});
