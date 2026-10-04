import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { CommerceError } from './types.js';
import { CommerceBuyer, type BuyerConfirmInput, type BuyerPreviewInput } from './buyer.js';
import { validateUrl } from './config.js';

export interface BuyerManagementOptions {
  buyer: CommerceBuyer;
  authenticate: (request: Request) => Promise<string | null>;
  origin: string;
}
const loopback = (host: string) => ['localhost', '127.0.0.1', '[::1]', '::1'].includes(host);
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) throw new CommerceError('invalid_content_type', 'Send application/json');
  let size = 0; const chunks: Uint8Array[] = [];
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > 1024 * 1024) { await reader.cancel(); throw new CommerceError('request_too_large', 'Management request exceeds 1 MiB'); } chunks.push(value); }
  }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new CommerceError('invalid_json', 'Valid JSON object required'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CommerceError('invalid_json', 'Valid JSON object required');
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, expected: string[]): void {
  if (Object.keys(value).some(key => !expected.includes(key)) || expected.some(key => !Object.hasOwn(value, key))) throw new CommerceError('invalid_request', 'Request fields do not match this management operation');
}

/** Private API: authentication binds every purchase to its caller. No CORS or public wallet proxy. */
export class BuyerManagement {
  readonly origin: string;
  constructor(private readonly options: BuyerManagementOptions) {
    const url = validateUrl(options.origin, true);
    if (url.pathname !== '/' || url.search || (!loopback(url.hostname) && url.protocol !== 'https:')) throw new CommerceError('management_origin', 'Use a loopback origin or an explicitly configured HTTPS management origin');
    this.origin = url.origin;
  }
  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.origin !== this.origin || (request.headers.get('Host') && request.headers.get('Host') !== url.host)) return Response.json({ error: 'invalid_host' }, { status: 421, headers });
    if (request.headers.get('Origin') && request.headers.get('Origin') !== this.origin) return Response.json({ error: 'origin_not_allowed' }, { status: 403, headers });
    if (request.method === 'OPTIONS') return Response.json({ error: 'method_not_allowed' }, { status: 405, headers });
    try {
      const caller = await this.options.authenticate(request);
      if (!caller) return Response.json({ error: 'authentication_required' }, { status: 401, headers: { ...headers, 'WWW-Authenticate': 'Bearer' } });
      if (url.search) throw new CommerceError('invalid_request', 'Management query parameters are not supported');
      if (request.method === 'GET' && url.pathname === '/management/v1/policy') return Response.json(this.options.buyer.policySnapshot(), { headers });
      if (request.method === 'POST' && url.pathname === '/management/v1/purchases/preview') {
        const body = await jsonBody(request); exactKeys(body, ['cardUrl', 'messageId', 'input', 'offerId']);
        return Response.json(await this.options.buyer.preview(caller, body as unknown as BuyerPreviewInput), { headers });
      }
      if (request.method === 'POST' && url.pathname === '/management/v1/purchases/confirm') {
        const body = await jsonBody(request); exactKeys(body, ['previewId', 'quoteToken', 'messageId']);
        if (['previewId', 'quoteToken', 'messageId'].some(key => typeof body[key] !== 'string')) throw new CommerceError('invalid_request', 'Confirmation identifiers must be strings');
        return Response.json(await this.options.buyer.confirm(caller, body as unknown as BuyerConfirmInput), { headers });
      }
      const match = /^\/management\/v1\/purchases\/([0-9a-f-]{36})(\/(?:recover|continue))?$/.exec(url.pathname);
      if (match && request.method === 'GET' && !match[2]) return Response.json(this.options.buyer.get(caller, match[1]!), { headers });
      if (match && request.method === 'POST' && match[2] === '/continue') {
        const body = await jsonBody(request); exactKeys(body, ['messageId', 'input']);
        if (typeof body.messageId !== 'string') throw new CommerceError('invalid_request', 'Continuation message ID must be a string');
        return Response.json(await this.options.buyer.continue(caller, match[1]!, body as unknown as { messageId: string; input: BuyerPreviewInput['input'] }), { headers });
      }
      if (match && request.method === 'POST' && match[2] === '/recover') {
        if (request.body) { const body = await jsonBody(request); exactKeys(body, []); }
        return Response.json(await this.options.buyer.recover(caller, match[1]!), { headers });
      }
      return Response.json({ error: 'not_found' }, { status: 404, headers });
    } catch (error) {
      const code = error instanceof CommerceError ? error.code : 'request_failed';
      const status = code === 'purchase_not_found' ? 404 : code === 'request_too_large' ? 413 : ['purchase_conflict', 'quote_expired', 'approval_mismatch', 'budget_exceeded', 'payments_disabled'].includes(code) ? 409 : 400;
      return Response.json({ error: code }, { status, headers });
    }
  }
}

export function listenBuyerManagement(management: BuyerManagement, origin = management.origin, host = '127.0.0.1', port = 4021) {
  if (new URL(origin).origin !== management.origin || (!loopback(host) && new URL(origin).protocol !== 'https:')) throw new CommerceError('management_bind', 'Remote management requires an explicit HTTPS reverse proxy origin');
  const server = createServer(async (req, res) => {
    try {
      if (req.headers.host !== new URL(origin).host) { res.writeHead(421, headers); res.end('{"error":"invalid_host"}'); return; }
      const incoming = new Headers(); for (const [key, value] of Object.entries(req.headers)) if (value !== undefined) incoming.set(key, Array.isArray(value) ? value.join(',') : value);
      const request = new Request(new URL(req.url ?? '/', origin), { method: req.method, headers: incoming, ...(req.method !== 'GET' && req.method !== 'HEAD' ? { body: Readable.toWeb(req) as ReadableStream<Uint8Array>, duplex: 'half' } : {}) } as RequestInit);
      const response = await management.handle(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]).pipe(res); else res.end();
    } catch { if (!res.headersSent) res.writeHead(500, headers); res.end('{"error":"request_failed"}'); }
  });
  server.requestTimeout = 30000; server.headersTimeout = 15000; server.listen(port, host); return server;
}
