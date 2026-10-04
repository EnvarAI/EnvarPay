import { Mppx } from 'mppx/server/core';
import { charge } from 'mppx/stripe/server';
import { Challenge, Credential, Receipt } from 'mppx';
import { CommerceStore, type OrderRecord } from './store.js';
import { CredentialVault } from './vault.js';
import { CommerceError } from './types.js';
import { digest } from './config.js';
import type { GateResult } from './x402.js';

export interface StripeIntent {
  id: string;
  status: string;
  amount: number;
  amount_received?: number;
  currency: string;
  livemode: boolean;
  metadata: Record<string, string>;
  lastResponse?: { headers?: Record<string, string> };
}
export interface StripeProvider {
  accountId: string;
  merchantProfile: string;
  mode: 'test' | 'live';
  assertReady(): Promise<void>;
  create(params: Record<string, unknown>, options: { idempotencyKey: string; apiVersion: string }): Promise<StripeIntent>;
  retrieve(id: string): Promise<StripeIntent>;
  findOriginal(orderId: string): Promise<StripeIntent | undefined>;
}
export interface MppGateOptions {
  store: CommerceStore;
  vault: CredentialVault;
  origin: string;
  hmacSecret: string;
  providers: Readonly<Record<string, StripeProvider>>;
}
interface SavedMppCredential {
  quoteId: string;
  accountId: string;
  mode: 'test' | 'live';
  credential: Credential.Credential<{ spt: string; externalId: string }>;
}

/** Native MPP Stripe charge; only a verified PSP success may queue a task. */
export class MppGate {
  constructor(private options: MppGateOptions) {
    if (Buffer.byteLength(options.hmacSecret) < 32) throw new CommerceError('mpp_hmac_key', 'MPP challenge key must contain at least 32 bytes');
  }
  merchantRecipient(accountRef: string): string | undefined { return this.options.providers[accountRef]?.merchantProfile; }
  async check(): Promise<void> {
    for (const provider of Object.values(this.options.providers)) await provider.assertReady();
  }
  private provider(order: OrderRecord): StripeProvider {
    const profile = order.quote.paymentProfile;
    if (profile?.adapter !== 'mpp') throw new CommerceError('payment_method_unavailable', 'Not an MPP offer');
    const provider = this.options.providers[profile.accountRef];
    if (!provider || provider.merchantProfile !== order.quote.recipient) throw new CommerceError('merchant_not_ready', 'Configured merchant must match original quote');
    return provider;
  }
  private optionsFor(order: OrderRecord, provider: StripeProvider) {
    const amount = BigInt(order.quote.amount);
    if (amount < 50n || amount > 99999999n) throw new CommerceError('stripe_amount', 'Stripe USD purchase must be 50–99999999 cents');
    return {
      amount: `${amount / 100n}.${(amount % 100n).toString().padStart(2, '0')}`,
      currency: 'usd', decimals: 2, externalId: order.quote.quoteId,
      recipient: provider.merchantProfile, networkId: provider.merchantProfile,
      expires: order.quote.expiresAt,
      scope: `service:${order.serviceRevision}/offer:${order.offerId}`,
      meta: {
        caller: digest(order.caller), inputDigest: order.inputDigest, termsDigest: order.quote.termsDigest,
        messageId: order.messageId, quoteId: order.quote.quoteId, serviceId: order.quote.serviceId, serviceRevision: String(order.quote.serviceRevision),
        offerId: order.offerId, amount: order.quote.amount, currency: 'usd', recipient: provider.merchantProfile, expiresAt: order.quote.expiresAt,
      },
      metadata: { envarpay_order: order.id, envarpay_quote: order.quote.quoteId, envarpay_terms: order.quote.termsDigest },
    };
  }
  private runtime(create: StripeProvider['create']) {
    return Mppx.create({
      methods: [charge({ client: { paymentIntents: { create } }, paymentMethodTypes: ['card'] })],
      realm: new URL(this.options.origin).host, secretKey: this.options.hmacSecret, requiresAuth: true,
    });
  }
  private bound(intent: StripeIntent, order: OrderRecord, provider: StripeProvider): boolean {
    return intent.livemode === (provider.mode === 'live') && Number.isSafeInteger(intent.amount) && String(intent.amount) === order.quote.amount &&
      intent.currency === 'usd' && intent.metadata?.envarpay_order === order.id && intent.metadata.envarpay_quote === order.quote.quoteId && intent.metadata.envarpay_terms === order.quote.termsDigest;
  }
  private verified(intent: StripeIntent, order: OrderRecord, provider: StripeProvider): boolean {
    return this.bound(intent,order,provider) && intent.status === 'succeeded' && intent.livemode === (provider.mode === 'live') &&
      Number.isSafeInteger(intent.amount) && String(intent.amount) === order.quote.amount &&
      Number.isSafeInteger(intent.amount_received) && String(intent.amount_received) === order.quote.amount &&
      intent.currency === 'usd' && intent.metadata?.envarpay_order === order.id &&
      intent.metadata.envarpay_quote === order.quote.quoteId && intent.metadata.envarpay_terms === order.quote.termsDigest;
  }
  private receipt(intent: StripeIntent, order: OrderRecord, provider: StripeProvider): Record<string, unknown> {
    return {
      method: 'stripe', status: 'success', reference: intent.id, externalId: order.quote.quoteId,
      timestamp: new Date().toISOString(), amount: order.quote.amount, currency: 'usd',
      merchant: provider.merchantProfile, accountId: provider.accountId, livemode: intent.livemode,
    };
  }
  private headers(receipt: Record<string, unknown>): GateResult {
    return { headers: { 'Payment-Receipt': Receipt.serialize(receipt as Receipt.Receipt) } };
  }
  async recover(orderId: string, caller: string): Promise<{ state: string; taskId: string }> {
    const order = this.options.store.getOrder(orderId, caller);
    if (!order) throw new CommerceError('order_not_found', 'Original order not found');
    const attempt = this.options.store.paymentForOrder(order.id);
    if (!attempt) throw new CommerceError('attempt_not_found', 'No original MPP attempt');
    if (attempt.state === 'confirmed' || attempt.state === 'rejected') return { state: attempt.state, taskId: order.taskId };
    const provider = this.provider(order);
    const saved = this.options.vault.get(attempt.credentialRef) as SavedMppCredential;
    if (saved.quoteId !== order.quote.quoteId || saved.accountId !== provider.accountId || saved.mode !== provider.mode) throw new CommerceError('recovery_conflict', 'Original provider binding changed');
    // Read only: Stripe idempotency cache expiry must never cause a second charge.
    const reference = attempt.receipt?.reference;
    const intent = typeof reference === 'string' && /^pi_[A-Za-z0-9]+$/.test(reference)
      ? await provider.retrieve(reference) : await provider.findOriginal(order.id);
    if (!intent) return { state: 'unknown', taskId: order.taskId };
    if (this.verified(intent, order, provider)) {
      this.options.store.recordSettlement(attempt.id, 'confirmed', this.receipt(intent, order, provider));
      return { state: 'confirmed', taskId: order.taskId };
    }
    // An action-required or declined intent might still change later. Only a
    // canceled PSP intent is definitive non-payment; do not release on timeout.
    const canceled = this.bound(intent,order,provider) && intent.status === 'canceled' && intent.amount_received === 0;
    const state = canceled ? 'rejected' : 'unknown';
    this.options.store.recordSettlement(attempt.id, state, { reference: intent.id, providerState: intent.status, livemode: intent.livemode });
    return { state, taskId: order.taskId };
  }
  async handle(request: Request, order: OrderRecord): Promise<GateResult> {
    const provider = this.provider(order);
    const prior = this.options.store.paymentForOrder(order.id);
    if (order.paymentState === 'confirmed' && prior?.receipt) return this.headers(prior.receipt);
    if (['settling', 'unknown'].includes(order.paymentState)) {
      const recovered = await this.recover(order.id, order.caller);
      if (recovered.state === 'confirmed') return this.headers(this.options.store.paymentForOrder(order.id)!.receipt!);
      return { response: Response.json({ error: 'payment_reconciliation_required', state: recovered.state }, { status: 503 }) };
    }
    if (Date.now() >= Date.parse(order.quote.expiresAt)) return { response: Response.json({ error: 'quote_expired' }, { status: 409 }) };
    await provider.assertReady();
    const runtime = this.runtime(provider.create.bind(provider));
    const options = this.optionsFor(order, provider);
    let challenge = this.options.store.paymentChallenge<Challenge.Challenge>(order.id);
    if (!challenge) challenge = this.options.store.freezePaymentChallenge(order.id, await runtime.challenge.stripe.charge(options));
    const unpaid = (): GateResult => ({ response: new Response('{}', { status: 402, headers: {
      'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'WWW-Authenticate': Challenge.serialize(challenge!),
    } }) });
    const header = request.headers.get('Payment-Authorization');
    if (!header) return unpaid();
    if (header.length > 32768) throw new CommerceError('payment_payload_size', 'Payment credential exceeds limit');
    let credential: SavedMppCredential['credential'];
    try { credential = Credential.deserialize(header); } catch { throw new CommerceError('invalid_payment', 'Malformed MPP credential'); }
    // Equality against a server-persisted native challenge complements the SDK HMAC.
    if (Challenge.serialize(credential.challenge) !== Challenge.serialize(challenge) || !Challenge.verify(credential.challenge, { secretKey: this.options.hmacSecret }) ||
        credential.payload.externalId !== order.quote.quoteId || !/^spt_[A-Za-z0-9_]+$/.test(credential.payload.spt)) {
      throw new CommerceError('quote_mismatch', 'MPP credential does not match the original order');
    }
    const saved: SavedMppCredential = { quoteId: order.quote.quoteId, accountId: provider.accountId, mode: provider.mode, credential };
    const ref = this.options.vault.put(saved);
    const attempt = this.options.store.reservePayment(order.id, order.caller, digest({ protocol: 'mpp', spt: credential.payload.spt }), ref);
    const wrapped = this.runtime(async (params, requestOptions) => {
      const intent = await provider.create(params, requestOptions);
      // Preserve original PI even if SDK reports requires_action or replay.
      this.options.store.recordSettlement(attempt, 'unknown', { reference: intent.id, providerState: intent.status, livemode: intent.livemode });
      return intent;
    });
    try {
      await wrapped.broadcastCredential(credential, { realm: new URL(this.options.origin).host, request: options, scope: options.scope, meta: options.meta });
    } catch {
      if (this.options.store.paymentForOrder(order.id)?.state === 'settling') this.options.store.recordSettlement(attempt, 'unknown', {});
    }
    const recovered = await this.recover(order.id, order.caller);
    if (recovered.state === 'confirmed') return this.headers(this.options.store.paymentForOrder(order.id)!.receipt!);
    return { response: Response.json({ error: 'payment_not_confirmed', state: recovered.state }, { status: 503 }) };
  }
}
