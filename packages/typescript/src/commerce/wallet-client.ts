import { Challenge, Credential, Method, Receipt } from 'mppx';
import { Mppx } from 'mppx/client';
import { z } from 'zod/mini';
import { CommerceError } from './types.js';
import { atomic, digest, validateUrl } from './config.js';

export type WalletEnvironment = 'sandbox' | 'live';
export interface WalletReceipt extends Receipt.Receipt {
  [key:string]:unknown;
  method: 'envar'; amount: string; currency: 'cny'; recipient: string;
  issuer: string; environment: WalletEnvironment; bindingDigest: string; externalId: string;
}
export interface WalletPayment {
  id: string; state: 'reserved' | 'captured' | 'partially_refunded' | 'refunded' | 'voided' | 'expired';
  amount: string; currency: 'cny'; recipient: string; issuer: string; environment: WalletEnvironment;
  challengeId: string; bindingDigest: string; expiresAt: string; refunded: string;
  paymentToken?: string; receipt?: WalletReceipt;
}
export interface WalletOptions {
  issuer: string; credential: string; environment: WalletEnvironment; fetchImpl?: typeof fetch;
}
export function publicWalletReceipt(receipt:WalletReceipt):WalletReceipt {
  return {method:'envar',status:'success',reference:receipt.reference,timestamp:receipt.timestamp,
    amount:receipt.amount,currency:'cny',recipient:receipt.recipient,issuer:receipt.issuer,
    environment:receipt.environment,bindingDigest:receipt.bindingDigest,externalId:receipt.externalId};
}
export class WalletApiError extends CommerceError {
  constructor(code: string, readonly status: number) { super(code, 'Wallet operation requires attention'); }
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function walletUrl(value: string, environment: WalletEnvironment): URL {
  const parsed = new URL(value);
  const local = environment === 'sandbox' && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
  return validateUrl(value, local);
}

/** Strip SDK convenience properties; these are the actual MPP challenge fields. */
export function walletChallengeWire(challenge: Challenge.Challenge) {
  return {
    id: challenge.id, realm: challenge.realm, method: challenge.method, intent: challenge.intent,
    request: challenge.request, expires: challenge.expires, digest: challenge.digest,
    header: challenge.header, opaque: challenge.opaque,
  };
}

/** Experimental Envar method; callers still supply their own approval and funds policy. */
export const envarMethod = Method.from({
  name: 'envar', intent: 'charge', schema: {
    request: z.object({
      amount: z.string(), currency: z.literal('cny'), recipient: z.string(), externalId: z.string(),
      methodDetails: z.object({ version: z.literal('1'), issuer: z.string() }),
    }),
    credential: { payload: z.object({ paymentToken: z.string() }) },
  },
});

export async function walletCredential(challenge: Challenge.Challenge, token: string): Promise<string> {
  const client = Mppx.create({ polyfill: false, maxPaymentRetries: 0, methods: [Method.toClient(envarMethod, {
    createCredential: async ({ challenge }) => Credential.serialize({ challenge, payload: { paymentToken: token } }),
  })] });
  const prepared = await client.preparePayment(new Response(null, {
    status: 402, headers: { 'WWW-Authenticate': Challenge.serialize(challenge) },
  }));
  return prepared.createCredential();
}

export function assertWalletCredential(value: string, challenge: Challenge.Challenge): string {
  const parsed = Credential.deserialize(value);
  const token = (parsed.payload as { paymentToken?: unknown }).paymentToken;
  if (Challenge.serialize(parsed.challenge) !== Challenge.serialize(challenge) || typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(token)) {
    throw new CommerceError('wallet_credential_binding', 'Wallet credential differs from the original challenge');
  }
  return token;
}

export class WalletHttp {
  readonly issuer: string;
  readonly environment: WalletEnvironment;
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly options: WalletOptions) {
    const parsed = walletUrl(options.issuer, options.environment);
    if (parsed.pathname !== '/' || parsed.search || !['sandbox', 'live'].includes(options.environment) || !/^[A-Za-z0-9_-]{32,128}$/.test(options.credential)) {
      throw new CommerceError('wallet_configuration', 'Configure an explicit wallet issuer, environment and scoped credential');
    }
    this.issuer = parsed.origin; this.environment = options.environment; this.fetchImpl = options.fetchImpl ?? fetch;
  }
  async request(path: string, body?: unknown, key?: string): Promise<Record<string, unknown>> {
    // The issuer is operator configured, never taken from a remote challenge or receipt.
    if (!path.startsWith('/api/v1/wallet/') || path.includes('..')) throw new CommerceError('wallet_scope', 'Wallet request escaped its API');
    const response = await this.fetchImpl(this.issuer + path, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${this.options.credential}`, 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const chunks: Uint8Array[] = []; let size = 0;
    if (response.body) {
      const reader = response.body.getReader();
      for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > 1024 * 1024) { await reader.cancel(); throw new CommerceError('wallet_response_size', 'Wallet response exceeds 1 MiB'); } chunks.push(next.value); }
    }
    let result: Record<string, unknown>;
    try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>; }
    catch { throw new CommerceError('wallet_response', 'Wallet returned invalid JSON'); }
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new CommerceError('wallet_response', 'Wallet returned invalid JSON');
    if (!response.ok) {
      const code = (result.error as { code?: unknown } | undefined)?.code;
      throw new WalletApiError(typeof code === 'string' && /^[a-z_]{1,80}$/.test(code) ? code : 'wallet_unavailable', response.status);
    }
    return result;
  }
  protected payment(value: Record<string, unknown>): WalletPayment {
    if (typeof value.id !== 'string' || !uuid.test(value.id) || value.issuer !== this.issuer || value.environment !== this.environment || value.currency !== 'cny' ||
      typeof value.recipient !== 'string' || !uuid.test(value.recipient) || typeof value.amount !== 'string' || atomic(value.amount) > 1000000000000n ||
      !['reserved','captured','partially_refunded','refunded','voided','expired'].includes(String(value.state)) ||
      typeof value.bindingDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.bindingDigest) || typeof value.challengeId !== 'string') {
      throw new CommerceError('wallet_payment_binding', 'Wallet returned invalid payment facts');
    }
    if(typeof value.refunded!=='string'||!/^(0|[1-9][0-9]*)$/.test(value.refunded)||BigInt(value.refunded)>BigInt(value.amount as string))throw new CommerceError('wallet_payment_binding','Invalid wallet refund amount');
    if(['captured','refunded','partially_refunded'].includes(String(value.state))){
      const receipt=value.receipt as WalletReceipt|undefined;
      if(!receipt||receipt.method!=='envar'||receipt.status!=='success'||receipt.reference!==value.id||receipt.amount!==value.amount||receipt.currency!=='cny'||receipt.recipient!==value.recipient||receipt.issuer!==value.issuer||receipt.environment!==value.environment||receipt.bindingDigest!==value.bindingDigest||typeof receipt.externalId!=='string'||!Number.isFinite(Date.parse(receipt.timestamp)))throw new CommerceError('wallet_receipt_binding','Invalid authoritative wallet receipt');
    }else if(value.receipt)throw new CommerceError('wallet_receipt_binding','An uncaptured payment cannot carry a receipt');
    return value as unknown as WalletPayment;
  }
  async getPayment(id: string): Promise<WalletPayment> {
    if (!uuid.test(id)) throw new CommerceError('wallet_reference', 'Invalid wallet charge reference');
    return this.payment(await this.request(`/api/v1/wallet/payments/${id}`));
  }
}

export class EnvarWalletClient extends WalletHttp {
  readonly payer: string;
  private readonly identities = new Map<string, { token: string; subject: string; expires: number }>();
  constructor(options: WalletOptions & { principal: string }) {
    super(options); this.payer = options.principal;
    if (!this.payer || this.payer.length > 255) throw new CommerceError('wallet_principal', 'An explicitly approved grant principal is required');
  }
  async check(): Promise<void> {
    const info = await this.request('/api/v1/wallet/authorization');
    if (info.principal !== this.payer || info.issuer !== this.issuer || info.environment !== this.environment || info.currency !== 'cny' || info.methodVersion !== '1') {
      throw new CommerceError('wallet_principal', 'Credential does not match the configured grant principal');
    }
  }
  async identity(merchant: string, endpoint: string): Promise<{ token: string; subject: string }> {
    const cacheKey = merchant + ':' + endpoint, prior = this.identities.get(cacheKey);
    if (prior && prior.expires > Date.now() + 30000) return prior;
    await this.check();
    const result = await this.request('/api/v1/wallet/identity', { merchant, endpoint });
    if (typeof result.access_token !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(result.access_token) || typeof result.subject !== 'string' || !/^[a-f0-9]{64}$/.test(result.subject) || result.token_type !== 'Bearer' || result.expires_in !== 300) {
      throw new CommerceError('wallet_identity', 'Wallet returned an invalid scoped A2A identity');
    }
    const value = { token: result.access_token, subject: result.subject, expires: Date.now() + 300000 };
    this.identities.set(cacheKey, value); return value;
  }
  async reserve(challenge: Challenge.Challenge, purchaseKey: string): Promise<WalletPayment> {
    const result = this.payment(await this.request('/api/v1/wallet/payments/reserve', { challenge: walletChallengeWire(challenge), purchaseKey }));
    this.assertChallenge(result, challenge); return result;
  }
  async lookup(purchaseKey: string, challenge: Challenge.Challenge): Promise<WalletPayment> {
    const result = this.payment(await this.request(`/api/v1/wallet/payments/lookup?purchaseKey=${encodeURIComponent(purchaseKey)}`));
    this.assertChallenge(result, challenge); return result;
  }
  assertChallenge(payment: WalletPayment, challenge: Challenge.Challenge): void {
    if (payment.amount !== challenge.request.amount || payment.recipient !== challenge.request.recipient || payment.challengeId !== challenge.id || payment.bindingDigest !== digest(walletChallengeWire(challenge))) {
      throw new CommerceError('wallet_payment_binding', 'Wallet payment differs from the original challenge');
    }
  }
  async verify(receipt: WalletReceipt, challenge: Challenge.Challenge): Promise<WalletPayment> {
    const payment = await this.getPayment(receipt.reference); this.assertChallenge(payment, challenge);
    if (!payment.receipt || digest(payment.receipt) !== digest(receipt)) throw new CommerceError('wallet_receipt_binding', 'Seller receipt is not independently confirmed by the wallet');
    return payment;
  }
}

export class EnvarMerchantClient extends WalletHttp {
  constructor(options: WalletOptions & { merchant: string }) { super(options); this.merchant = options.merchant; if (!uuid.test(this.merchant)) throw new CommerceError('wallet_merchant', 'A registered merchant ID is required'); }
  readonly merchant: string;
  async register(challenge: Challenge.Challenge): Promise<void> {
    const result = await this.request('/api/v1/wallet/merchant/challenges', { challenge: walletChallengeWire(challenge) });
    if (digest(result.challenge) !== digest(walletChallengeWire(challenge))) throw new CommerceError('wallet_challenge_binding', 'Wallet registered different payment terms');
  }
  async lookup(challenge: Challenge.Challenge): Promise<WalletPayment | undefined> {
    try { return this.payment(await this.request(`/api/v1/wallet/merchant/payments/lookup?challengeId=${encodeURIComponent(challenge.id)}`)); }
    catch (error) { if (error instanceof WalletApiError && error.status === 404) return undefined; throw error; }
  }
  async redeem(token: string, challenge: Challenge.Challenge, caller: string, endpoint: string): Promise<WalletPayment> {
    return this.payment(await this.request('/api/v1/wallet/payments/redeem', {
      paymentToken: token, binding: { challengeId: challenge.id, callerBinding: caller, endpoint, bodyDigest: challenge.digest },
    }));
  }
  async complete(id: string): Promise<void> { if (!uuid.test(id)) throw new CommerceError('wallet_reference','Invalid payment ID'); await this.request(`/api/v1/wallet/payments/${id}/complete`, {}); }
  async refund(id: string, amount: string, reason: string, key: string): Promise<WalletPayment> {
    if (!uuid.test(id)) throw new CommerceError('wallet_reference','Invalid payment ID');
    return this.payment(await this.request(`/api/v1/wallet/payments/${id}/refund`, { amount, reason }, key));
  }
  /** Standard Bearer introspection. No wallet spend credential reaches the seller. */
  authenticator(): (request: Request) => Promise<string | null> {
    return async request => {
      const token = request.headers.get('Authorization')?.match(/^Bearer ([A-Za-z0-9_-]{32,128})$/)?.[1];
      if (!token) return null;
      const result = await this.request('/api/v1/wallet/oauth/introspect', { token });
      return result.active === true && result.iss === this.issuer && result.aud === request.url && result.scope === 'a2a' &&
        typeof result.exp === 'number' && result.exp * 1000 > Date.now() && typeof result.sub === 'string' && /^[a-f0-9]{64}$/.test(result.sub) ? result.sub : null;
    };
  }
}
