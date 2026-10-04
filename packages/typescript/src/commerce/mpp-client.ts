import { Challenge, Credential, Receipt } from 'mppx';
import { Mppx } from 'mppx/client';
import { charge } from 'mppx/stripe/client';
import { createHash } from 'node:crypto';
import { CommerceError } from './types.js';
import type { BuyerQuote } from './buyer-store.js';

export type MppReceipt = Receipt.Receipt & { amount: string; currency: 'usd'; merchant: string; accountId?: string; livemode: boolean };
export interface MppTokenOperation {
  operationId: string; idempotencyKey: string; purchaseId: string; quote: BuyerQuote;
  mode: 'test' | 'live'; amount: string; currency: string; networkId: string;
  expiresAt: number; paymentMethod: string; metadata?: Record<string, string>;
  challenge: Challenge.Challenge;
}
export interface MppVerificationContext {
  purchaseId: string; quote: BuyerQuote; mode: 'test' | 'live'; operationId: string;
}
export interface MppBuyerOptions {
  /** Stable private buyer/PSP identity; never inferred from seller metadata. */
  payer: string; mode: 'test' | 'live'; paymentMethod: string;
  createToken: (operation: MppTokenOperation) => Promise<string>;
  /** Read the original operation only; never create another SPT on absence. */
  recoverToken?: (operation: MppTokenOperation) => Promise<string | undefined>;
  /** Independently read provider state and match account/mode/merchant/amount/order. */
  verifyReceipt: (receipt: MppReceipt, context: MppVerificationContext) => Promise<boolean>;
}
export interface SavedMppAuthorization {
  protocol: 'mpp'; credential: string; challenge: Challenge.Challenge;
  fingerprint: string; operationId: string;
}
export interface SavedMppToken { protocol: 'mpp-token'; token: string; fingerprint: string; operationId: string; }

/** Native SDK preparation only; no fetch polyfill or automatic payment retry. */
export async function prepareMppCredential(challenge: Challenge.Challenge, paymentMethod: string, createToken: (parameters: charge.OnChallengeParameters) => Promise<string>) {
  const client = Mppx.create({ polyfill: false, maxPaymentRetries: 0, methods: [charge({ paymentMethod, createToken })] });
  const payment = await client.preparePayment(new Response(null, { status: 402, headers: { 'WWW-Authenticate': Challenge.serialize(challenge) } }));
  return payment.createCredential();
}
export function validateMppCredential(value: string, challenge: Challenge.Challenge): void {
  const credential = Credential.deserialize(value);
  const payload = credential.payload as { externalId?: string; spt?: string };
  if (Challenge.serialize(credential.challenge) !== Challenge.serialize(challenge) || payload.externalId !== challenge.request.externalId || typeof payload.spt !== 'string' || !/^spt_[A-Za-z0-9_]+$/.test(payload.spt)) throw new CommerceError('mpp_credential_binding', 'Native MPP credential differs from the original challenge');
}
export function assertMppDigest(challenge: Challenge.Challenge, body: string): void {
  if (challenge.digest && challenge.digest !== `sha-256=:${createHash('sha256').update(body).digest('base64')}:`) throw new CommerceError('mpp_request_digest', 'MPP challenge is bound to different request bytes');
}
export function publicMppReceipt(value: MppReceipt): MppReceipt {
  return { method: value.method, status: value.status, reference: value.reference, timestamp: value.timestamp, ...(value.externalId ? { externalId: value.externalId } : {}), amount: value.amount, currency: value.currency, merchant: value.merchant, livemode: value.livemode, ...(value.accountId ? { accountId: value.accountId } : {}) };
}
