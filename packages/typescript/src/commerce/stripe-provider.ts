import { CommerceError } from './types.js';
import type { StripeIntent, StripeProvider } from './mpp.js';

export interface StripeProviderConfig {
  secretKey: string;
  accountId: string;
  merchantProfile: string;
  mode: 'test' | 'live';
}

/** Stripe REST transport used by the official mppx Stripe method. No SPT creation. */
export function stripeProvider(config: StripeProviderConfig, fetchImpl: typeof fetch = fetch): StripeProvider {
  if (!/^acct_[A-Za-z0-9]+$/.test(config.accountId) || !/^profile_[A-Za-z0-9]+$/.test(config.merchantProfile) ||
      !config.secretKey.startsWith(config.mode === 'live' ? 'sk_live_' : 'sk_test_')) {
    throw new CommerceError('stripe_configuration', 'Explicit matching Stripe account, profile and test/live credentials are required');
  }
  const call = async (path: string, method = 'GET', params?: Record<string, unknown>, options?: { apiVersion?: string; idempotencyKey?: string }): Promise<Record<string, unknown>> => {
    const body = new URLSearchParams();
    const add = (key: string, value: unknown): void => {
      if (value === undefined || value === null) return;
      if (Array.isArray(value)) { value.forEach((v, i) => add(`${key}[${i}]`, v)); return; }
      if (typeof value === 'object') { for (const [k, v] of Object.entries(value)) add(key ? `${key}[${k}]` : k, v); return; }
      if (!['boolean', 'number', 'string'].includes(typeof value)) throw new CommerceError('stripe_request', 'Unsupported Stripe value');
      body.set(key, String(value));
    };
    for (const [key, value] of Object.entries(params ?? {})) add(key, value);
    const headers = new Headers({ Authorization: `Bearer ${config.secretKey}` });
    if (options?.apiVersion) headers.set('Stripe-Version', options.apiVersion);
    if (options?.idempotencyKey) headers.set('Idempotency-Key', options.idempotencyKey);
    if (method !== 'GET') headers.set('Content-Type', 'application/x-www-form-urlencoded');
    const response = await fetchImpl(`https://api.stripe.com${path}${method === 'GET' && body.size ? '?' + body.toString() : ''}`, {
      method, headers, ...(method === 'GET' ? {} : { body }), redirect: 'error', signal: AbortSignal.timeout(20000),
    });
    const reader = response.body?.getReader(); let size = 0; const chunks: Uint8Array[] = [];
    if (reader) for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength;
      if (size > 1024 * 1024) { await reader.cancel(); throw new CommerceError('stripe_response_size', 'Stripe response exceeds limit'); } chunks.push(value); }
    let result: Record<string, unknown>;
    try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new CommerceError('stripe_response', 'Stripe returned invalid JSON'); }
    // Do not surface provider error text that might echo SPT or customer details.
    if (!response.ok) throw new CommerceError(response.status === 429 ? 'stripe_rate_limit' : 'stripe_request_failed', `Stripe request failed (HTTP ${response.status})`);
    return { ...result, lastResponse: { headers: { 'idempotent-replayed': response.headers.get('idempotent-replayed') ?? 'false' } } };
  };
  const validateIntent = (value: Record<string, unknown>): StripeIntent => {
    if (typeof value.id !== 'string' || !/^pi_[A-Za-z0-9]+$/.test(value.id) || typeof value.status !== 'string' ||
        !Number.isSafeInteger(value.amount) || typeof value.livemode !== 'boolean' || !value.metadata || typeof value.metadata !== 'object') {
      throw new CommerceError('stripe_response', 'Stripe returned an invalid PaymentIntent');
    }
    return value as unknown as StripeIntent;
  };
  return {
    accountId: config.accountId, merchantProfile: config.merchantProfile, mode: config.mode,
    async assertReady() {
      const account = await call('/v1/account');
      if (account.id !== config.accountId) throw new CommerceError('stripe_account_mismatch', 'Stripe key belongs to another account');
      if (config.mode === 'live' && account.charges_enabled !== true) throw new CommerceError('stripe_charges_disabled', 'Live merchant is not enabled for charges');
    },
    async create(params, options) { return validateIntent(await call('/v1/payment_intents', 'POST', params, options)); },
    async retrieve(id) {
      if (!/^pi_[A-Za-z0-9]+$/.test(id)) throw new CommerceError('stripe_reference', 'Invalid original PaymentIntent');
      return validateIntent(await call(`/v1/payment_intents/${id}`));
    },
    async findOriginal(orderId) {
      if (!/^[0-9a-f-]{36}$/.test(orderId)) throw new CommerceError('order_reference', 'Invalid original order');
      const result = await call('/v1/payment_intents/search', 'GET', { query: `metadata['envarpay_order']:'${orderId}'`, limit: 2 });
      if (!Array.isArray(result.data) || result.has_more || result.data.length > 1) throw new CommerceError('ambiguous_payment', 'Multiple intents require original-operation reconciliation');
      // Stripe search may be eventually consistent. No match remains unknown.
      return result.data.length ? validateIntent(result.data[0]) : undefined;
    },
  };
}
