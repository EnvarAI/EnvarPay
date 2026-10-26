/** Outbound HTTPS application client. Tokens never leave the selected Envar origin. */
import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsImport from 'ajv-formats';
import type { Claim, ConfirmOrderResult, ExecutionRef, Inbox, Order, Report, ServiceConfirmation, ServiceQuoteRequest, Submit, Work } from './contracts.generated.js';
import { digest } from '../commerce/config.js';

const ajv = new Ajv2020({ allErrors: false, strict: true });
(addFormatsImport as unknown as (value: Ajv2020) => void)(ajv);
const schema = JSON.parse(readFileSync(new URL('../../schemas/agent-work.v1.schema.json', import.meta.url), 'utf8'));
ajv.addSchema(schema);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function id(value: string): string {
  if (!uuid.test(value)) throw new Error('Use an Envar UUID');
  return value;
}
export function validate<T>(kind: string, value: unknown): T {
  const validator = ajv.getSchema(`${schema.$id}#/$defs/${kind}`);
  if (!validator || !validator(value)) throw new Error(`Invalid Agent Work ${kind} document`);
  return value as T;
}
export class WorkApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, public readonly retryAfter = 0) {
    super(`Envar request failed (${status}, ${code}). Read the original work before retrying.`);
  }
}
export interface ClaimedWork extends Work {
  claim?: Claim & { lease_until: string | null };
  execution_ref: Partial<ExecutionRef>;
  replayed?: boolean;
}
export interface ConnectionStatus {
  id: string;
  agent_id: string;
  mode: 'inbox' | 'direct';
  status: 'active' | 'revoked';
  platform: string;
  revision: number;
  readiness: Record<string, unknown>;
}
export class EnvarWorkClient {
  readonly origin: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  constructor(origin: string, token: string, options: { fetch?: typeof fetch; allowLocalHttp?: boolean } = {}) {
    const url = new URL(origin);
    const local = options.allowLocalHttp && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((!local && url.protocol !== 'https:') || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
      throw new Error('Choose the Envar HTTPS origin');
    if (!/^envar_agent_[A-Za-z0-9_-]{32,128}$/.test(token)) throw new Error('Use a scoped Envar connection credential');
    this.origin = url.origin; this.token = token; this.fetchImpl = options.fetch ?? fetch;
  }
  private async request(path: string, body?: unknown, key?: string, method?: 'DELETE'): Promise<unknown> {
    if (!path.startsWith('/api/v1/')) throw new Error('Invalid application route');
    const headers = new Headers({ Authorization: `Bearer ${this.token}`, Accept: 'application/json' });
    if (key) headers.set('Idempotency-Key', id(key));
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    if (encoded && Buffer.byteLength(encoded) > 262144) throw new Error('Work request exceeds the size limit');
    if (encoded) headers.set('Content-Type', 'application/json');
    const response = await this.fetchImpl(new URL(path, this.origin), {
      method: method ?? (body === undefined ? 'GET' : 'POST'), body: encoded, headers, redirect: 'error', signal: AbortSignal.timeout(20000),
    });
    // One attempt only. The durable Connector decides which original operation can be retried.
    if (!response.ok) {
      const retry = Number(response.headers.get('Retry-After'));
      throw new WorkApiError(response.status, `http_${response.status}`, Number.isFinite(retry) ? Math.min(300, Math.max(0, retry)) : 0);
    }
    if (!response.body) throw new Error('Envar returned an empty response');
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 4 * 1024 * 1024) { await reader.cancel(); throw new Error('Envar response exceeds the size limit'); }
      chunks.push(part.value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new Error('Envar returned invalid JSON. Preserve the original request ID.'); }
  }
  async disconnect(): Promise<{ credential_revoked: boolean; connection_revoked: boolean }> {
    return await this.request('/api/v1/agent-connections/current/credential', {}, undefined, 'DELETE') as { credential_revoked: boolean; connection_revoked: boolean };
  }
  async status(): Promise<ConnectionStatus> {
    const value = await this.request('/api/v1/agent-connections/current') as ConnectionStatus;
    if (!value || !uuid.test(value.id) || !uuid.test(value.agent_id) || value.mode !== 'inbox' || value.status !== 'active')
      throw new Error('Reconnect this Agent to an active inbox');
    return value;
  }
  async peers(): Promise<{ items: { agent_id: string; connection_id: string; display_name: string; platform: string }[] }> {
    const value = await this.request('/api/v1/agent-connections/peers') as { items: { agent_id: string; connection_id: string; display_name: string; platform: string }[] };
    if (!value || !Array.isArray(value.items) || value.items.length > 100 || value.items.some(item =>
      !uuid.test(item.agent_id) || !uuid.test(item.connection_id) || typeof item.display_name !== 'string'))
      throw new Error('Invalid allowed-peer directory');
    return value;
  }
  async provideInput(workId: string, text: string, requestId: string): Promise<Work> {
    return validate('work', await this.request(`/api/v1/invocations/${id(workId)}/input`, validate('input', { text }), requestId));
  }
  async cancel(workId: string, requestId: string): Promise<Work> {
    return validate('work', await this.request(`/api/v1/invocations/${id(workId)}/cancel`, {}, requestId));
  }
  async inbox(after = 0): Promise<Inbox> {
    if (!Number.isSafeInteger(after) || after < 0) throw new Error('Invalid inbox cursor');
    return validate('inbox', await this.request(`/api/v1/inbox?after=${after}`));
  }
  async get(workId: string): Promise<Work> { return validate('work', await this.request(`/api/v1/invocations/${id(workId)}`)); }
  async send(request: Submit, requestId: string): Promise<Work> {
    validate('submit', request);
    return validate('work', await this.request('/api/v1/invocations', request, requestId));
  }
  private async claimed(path: string, body: unknown, requestId?: string): Promise<ClaimedWork> {
    const result = await this.request(path, body, requestId) as ClaimedWork;
    const { claim, execution_ref, replayed, ...work } = result;
    validate('work', work);
    if (path.endsWith('/claim') && ['completed', 'failed', 'canceled'].includes(work.status) && !uuid.test(claim?.id ?? ''))
      return { ...work, execution_ref, ...(replayed === undefined ? {} : { replayed }) };
    if (!claim) throw new Error('The active original work has no claim');
    validate('claim', { id: claim.id, fence: claim.fence });
    return { ...work, claim, execution_ref, ...(replayed === undefined ? {} : { replayed }) };
  }
  claim(workId: string, requestId: string): Promise<ClaimedWork> {
    return this.claimed(`/api/v1/invocations/${id(workId)}/claim`, {}, requestId);
  }
  start(workId: string, claim: Claim, execution_ref: ExecutionRef): Promise<ClaimedWork> {
    return this.claimed(`/api/v1/invocations/${id(workId)}/start`, validate('start', { claim, execution_ref }));
  }
  renew(workId: string, claim: Claim): Promise<ClaimedWork> {
    return this.claimed(`/api/v1/invocations/${id(workId)}/lease`, validate('lease', { claim }));
  }
  recover(workId: string, claim: Claim, execution_ref: ExecutionRef): Promise<ClaimedWork> {
    return this.claimed(`/api/v1/invocations/${id(workId)}/recover`, validate('recover', { claim, execution_ref }));
  }
  async report(workId: string, report: Report): Promise<Work> {
    return validate('work', await this.request(`/api/v1/invocations/${id(workId)}/work-events`, validate('report', report)));
  }
  async acknowledge(deliveryId: number): Promise<void> {
    if (!Number.isSafeInteger(deliveryId) || deliveryId < 1) throw new Error('Invalid delivery ID');
    await this.request(`/api/v1/inbox/${deliveryId}/ack`, {});
  }
  async services(query = '', serviceId?: string): Promise<{ results: Record<string, unknown>[] }> {
    if (query.length > 120) throw new Error('Use a bounded service query');
    const params = new URLSearchParams({ q: query });
    if (serviceId) params.set('service', id(serviceId));
    const value = await this.request('/api/v1/agent-commerce/services?' + params) as { results: Record<string, unknown>[] };
    if (!Array.isArray(value?.results) || value.results.length > 100) throw new Error('Invalid service directory');
    return value;
  }
  async spendingGrants(): Promise<{ items: Record<string, unknown>[] }> {
    const value = await this.request('/api/v1/agent-commerce/spending-grants') as { items: Record<string, unknown>[] };
    if (!Array.isArray(value?.items) || value.items.length > 100) throw new Error('Invalid Agent budget response');
    return value;
  }
  async quoteService(request: ServiceQuoteRequest): Promise<Order> {
    validate('service_quote_request', request);
    const order = validate<Order>('order', await this.request('/api/v1/agent-commerce/quotes', request, request.message_id));
    if (order.service_id !== request.service_id || order.message_id !== request.message_id || order.offer_id !== request.offer_id ||
      order.payment_method !== request.payment_method || order.quote.input_digest !== digest(request.input))
      throw new Error('The service quote differs from the original request');
    return order;
  }
  async order(orderId: string): Promise<Order> {
    const order = validate<Order>('order', await this.request(`/api/v1/agent-commerce/orders/${id(orderId)}`));
    if (order.id !== orderId) throw new Error('Envar returned a different original order');
    return order;
  }
  async orders(): Promise<{ items: Order[] }> {
    const value = await this.request('/api/v1/agent-commerce/orders') as { items: unknown[] };
    if (!Array.isArray(value?.items) || value.items.length > 100) throw new Error('Invalid original-order list');
    return { items: value.items.map(item => validate<Order>('order', item)) };
  }
  async confirmOrder(orderId: string, confirmation: ServiceConfirmation): Promise<ConfirmOrderResult> {
    validate('service_confirmation', confirmation);
    const receipt = validate<ConfirmOrderResult>('confirm_order_result', await this.request(
      `/api/v1/agent-commerce/orders/${id(orderId)}/confirm`, confirmation, orderId));
    if (receipt.order.id !== orderId || receipt.order.message_id !== confirmation.message_id)
      throw new Error('Confirmation returned another order');
    if (receipt.approval_required) {
      const approval = new URL(receipt.approval_url ?? '');
      if (approval.origin !== this.origin || approval.pathname !== `/console/orders/${orderId}` ||
          approval.username || approval.password || approval.search || approval.hash)
        throw new Error('Owner approval must remain on the original Envar order');
    }
    return receipt;
  }
  async recoverOrder(orderId: string): Promise<Order> {
    const order = validate<Order>('order', await this.request(`/api/v1/agent-commerce/orders/${id(orderId)}/recover`, {}, orderId));
    if (order.id !== orderId) throw new Error('Recovery returned another order');
    return order;
  }
}
