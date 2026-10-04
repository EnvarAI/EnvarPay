import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Challenge } from 'mppx';
import { digest, isStripeProfileId } from './config.js';
import { CommerceError } from './types.js';
import { CredentialVault } from './vault.js';
import { STRIPE_MPP_API_VERSION } from './stripe-provider.js';
import type { MppBuyerOptions, MppReceipt, MppTokenOperation, MppVerificationContext } from './mpp-client.js';
import { isStripeTestPaymentMethod } from './mpp-client.js';

/** Buyer and seller use the same public preview, independently of mppx internals. */
export const STRIPE_ISSUER_API_VERSION = STRIPE_MPP_API_VERSION;
const ACCOUNT = /^acct_[A-Za-z0-9]{1,128}$/;
const TOKEN = /^spt_[A-Za-z0-9_]{1,200}$/;
const PAYMENT_METHOD = /^pm_[A-Za-z0-9]{1,128}$/;
const OPERATION = /^[A-Za-z0-9_-]{1,200}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface StripeSellerReadBinding {
  accountId: string;
  /** Account-scoped read credential for account, profile and PaymentIntent reads. */
  secretKey: string;
}
export interface StripeMppBuyerConfig {
  payer: string;
  mode: 'test' | 'live';
  issuerAccountId: string;
  secretKey: string;
  /** Issuer's Stripe.js key; optional until customer authentication is needed. */
  publishableKey?: string;
  /** Previously owner-authorized PaymentMethod; this adapter never collects card data. */
  paymentMethod: string;
  sellers: Readonly<Record<string, StripeSellerReadBinding>>;
  returnUrl?: string;
  /** Real Stripe test infrastructure, selected explicitly; never a live fallback. */
  issuance?: 'issued-token' | 'test-helper';
}
export interface StripeMppBuyerRuntime {
  statePath: string;
  vault: CredentialVault;
  fetchImpl?: typeof fetch;
  now?: () => number;
}
export interface StripeAuthenticationAction { type: 'use_stripe_sdk'; hashedValue: string; }
export interface StripeMppBuyerAdapter extends MppBuyerOptions {
  assertReady(): Promise<void>;
  close(): void;
  /** Private owner-only API. Pass this value directly to Stripe.js, never logs. */
  authenticationAction(operationId: string): Promise<StripeAuthenticationAction | undefined>;
}
interface OriginalRequest {
  operation: MppTokenOperation;
  binding: { issuerAccountId: string; sellerAccountId: string; issuance: string; returnUrl?: string };
  body: string;
}
interface IssuerRow { operationId: string; fingerprint: string; requestRef: string; tokenRef?: string; }
type Json = Record<string, unknown>;
const object = (value: unknown): Json => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};

/** Durable private references only; exact requests and tokens live in CredentialVault. */
class IssuerLedger {
  private db!: DatabaseSync;
  private owner?: DatabaseSync;
  private closed = false;
  constructor(path: string) {
    if (typeof path !== 'string' || !path.trim() || path === ':memory:') throw new CommerceError('stripe_issuer_state', 'SPT issuance requires a durable private ledger');
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.owner = new DatabaseSync(path + '.owner.sqlite3');
    chmodSync(path + '.owner.sqlite3', 0o600);
    try { this.owner.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE'); }
    catch { this.owner.close(); throw new CommerceError('store_locked', 'Stripe issuer ledger already has an active process'); }
    try {
      this.db = new DatabaseSync(path);
      chmodSync(path, 0o600);
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS stripe_issuer_meta(version INTEGER NOT NULL);
        INSERT INTO stripe_issuer_meta SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM stripe_issuer_meta);
        CREATE TABLE IF NOT EXISTS stripe_issuer_operations(
          operation_id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, purchase_id TEXT NOT NULL UNIQUE,
          fingerprint TEXT NOT NULL, request_ref TEXT NOT NULL, token_ref TEXT,
          created_at INTEGER NOT NULL
        );`);
      if (this.db.prepare('SELECT version FROM stripe_issuer_meta').get()?.version !== 1) throw new CommerceError('store_version', 'Unsupported Stripe issuer ledger version');
    } catch (error) { this.db?.close(); this.owner.close(); throw error; }
  }
  get(id: string): IssuerRow | undefined {
    const row = this.db.prepare('SELECT * FROM stripe_issuer_operations WHERE operation_id=?').get(id);
    return row ? { operationId: String(row.operation_id), fingerprint: String(row.fingerprint), requestRef: String(row.request_ref), ...(row.token_ref ? { tokenRef: String(row.token_ref) } : {}) } : undefined;
  }
  insert(operation: MppTokenOperation, fingerprint: string, requestRef: string, now: number): IssuerRow {
    try {
      this.db.prepare('INSERT INTO stripe_issuer_operations VALUES(?,?,?,?,?,NULL,?)').run(operation.operationId, operation.idempotencyKey, operation.purchaseId, fingerprint, requestRef, now);
    } catch { throw new CommerceError('stripe_spt_operation_conflict', 'Purchase or idempotency identity already has an original issuer operation'); }
    return this.get(operation.operationId)!;
  }
  token(id: string, ref: string): void { this.db.prepare('UPDATE stripe_issuer_operations SET token_ref=? WHERE operation_id=? AND token_ref IS NULL').run(ref, id); }
  close(): void {
    if (this.closed) return;
    this.closed = true; this.db.close(); this.owner?.exec('ROLLBACK'); this.owner?.close();
  }
}

/** Official SPT issuer with exact scope and original-ID-only recovery. No automatic funding. */
export function createStripeMppBuyer(input: StripeMppBuyerConfig, runtime: StripeMppBuyerRuntime): StripeMppBuyerAdapter {
  const config = structuredClone(input), issuance = config.issuance ?? 'issued-token';
  const keyValid = (key: unknown): key is string => typeof key === 'string' && new RegExp(`^(?:sk|rk)_${config.mode}_[A-Za-z0-9]{1,256}$`).test(key);
  if (!['test', 'live'].includes(config.mode) || !['issued-token', 'test-helper'].includes(issuance) || !ACCOUNT.test(config.issuerAccountId) || !keyValid(config.secretKey) ||
      typeof config.payer !== 'string' || !config.payer || config.payer.length > 200 || !config.sellers || !Object.keys(config.sellers).length ||
      !(PAYMENT_METHOD.test(config.paymentMethod) || (issuance === 'test-helper' && isStripeTestPaymentMethod(config.paymentMethod)))) {
    throw new CommerceError('stripe_issuer_configuration', 'Explicit Stripe issuer, funding method, seller read bindings and mode are required');
  }
  for (const [profile, seller] of Object.entries(config.sellers)) {
    if (!isStripeProfileId(profile) || (config.mode === 'live' && profile.startsWith('profile_test_')) || !ACCOUNT.test(seller.accountId) || !keyValid(seller.secretKey)) throw new CommerceError('stripe_issuer_configuration', 'Seller profile, account and read credential must match the explicit mode');
  }
  if (issuance === 'test-helper' && (config.mode !== 'test' || !isStripeTestPaymentMethod(config.paymentMethod) || Object.values(config.sellers).some(s => s.accountId !== config.issuerAccountId))) {
    throw new CommerceError('stripe_test_helper_configuration', 'Test helper requires an explicitly supported test card and the same configured test seller account');
  }
  if (config.publishableKey !== undefined && (typeof config.publishableKey !== 'string' || !new RegExp(`^pk_${config.mode}_[A-Za-z0-9]{1,256}$`).test(config.publishableKey))) {
    throw new CommerceError('stripe_publishable_key', 'Stripe.js requires an issuer publishable key matching the configured mode');
  }
  if (config.returnUrl !== undefined) {
    let url: URL;
    try { url = new URL(config.returnUrl); } catch { throw new CommerceError('stripe_return_url', 'Stripe return URL must be an owner-configured HTTPS URL'); }
    if (url.protocol !== 'https:' || url.username || url.password || config.returnUrl.length > 2048) throw new CommerceError('stripe_return_url', 'Stripe return URL must be an owner-configured HTTPS URL');
  }
  const ledger = new IssuerLedger(runtime.statePath), vault = runtime.vault;
  const fetchImpl = runtime.fetchImpl ?? fetch, now = runtime.now ?? Date.now;
  const inFlight = new Set<string>();

  async function call(secret: string, path: string, body?: string, idempotencyKey?: string): Promise<Json> {
    const headers = new Headers({ Authorization: `Bearer ${secret}`, 'Stripe-Version': STRIPE_ISSUER_API_VERSION });
    if (body !== undefined) headers.set('Content-Type', 'application/x-www-form-urlencoded');
    if (idempotencyKey) headers.set('Idempotency-Key', idempotencyKey);
    let response: Response;
    try { response = await fetchImpl(`https://api.stripe.com${path}`, { method: body === undefined ? 'GET' : 'POST', headers, ...(body === undefined ? {} : { body }), redirect: 'error', signal: AbortSignal.timeout(20000) }); }
    catch { throw new CommerceError('stripe_transport_unknown', 'Stripe request outcome is unknown; retain the original operation'); }
    const reader = response.body?.getReader(); let size = 0; const chunks: Uint8Array[] = [];
    try {
      if (reader) for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > 1024 * 1024) { await reader.cancel(); throw new CommerceError('stripe_response_size', 'Stripe response exceeds limit'); }
        chunks.push(value);
      }
    } catch (error) {
      if (error instanceof CommerceError && error.code === 'stripe_response_size') throw error;
      throw new CommerceError('stripe_transport_unknown', 'Stripe response was interrupted; retain the original operation');
    }
    if (!response.ok) throw new CommerceError(response.status === 429 ? 'stripe_rate_limit' : 'stripe_request_failed', `Stripe request failed (HTTP ${response.status})`);
    let value: unknown;
    try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new CommerceError('stripe_response', 'Stripe returned invalid JSON'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CommerceError('stripe_response', 'Stripe returned an invalid object');
    return value as Json;
  }

  async function account(secret: string, id: string): Promise<Json> {
    const result = await call(secret, '/v1/account');
    if (result.id !== id || result.object !== 'account') throw new CommerceError('stripe_account_mismatch', 'Stripe credential does not prove the expected account');
    return result;
  }
  async function sellerReady(profile: string): Promise<StripeSellerReadBinding> {
    const seller = config.sellers[profile];
    if (!Object.hasOwn(config.sellers, profile) || !seller) throw new CommerceError('stripe_seller_binding', 'Seller is not in the local read-verification allowlist');
    const result = await account(seller.secretKey, seller.accountId);
    if (config.mode === 'live' && (result.charges_enabled !== true || object(result.capabilities).card_payments !== 'active')) throw new CommerceError('stripe_charges_disabled', 'Live seller card payments are not enabled');
    const ownProfile = await call(seller.secretKey, '/v2/network/business_profiles/me');
    // Require the documented mode as well as the credential-scoped /me identity.
    if (ownProfile.id !== profile || ownProfile.object !== 'v2.network.business_profile' || ownProfile.livemode !== (config.mode === 'live')) throw new CommerceError('stripe_profile_mismatch', 'Seller credential does not prove the expected profile and mode');
    return seller;
  }

  function requestFor(operation: MppTokenOperation): OriginalRequest {
    const quote = operation.quote, challenge = operation.challenge;
    const details = object(challenge?.request?.methodDetails), metadata = object(operation.metadata);
    const expiry = Math.floor(Date.parse(quote?.expiresAt) / 1000);
    if (!OPERATION.test(operation.operationId) || operation.idempotencyKey !== operation.operationId || !UUID.test(operation.purchaseId) ||
        operation.mode !== config.mode || operation.paymentMethod !== config.paymentMethod || operation.currency !== 'usd' || !/^[1-9][0-9]{1,7}$/.test(operation.amount) ||
        BigInt(operation.amount) < 50n || BigInt(operation.amount) > 99999999n || operation.amount !== quote.amount || quote.currency !== 'usd' || quote.payer !== config.payer ||
        operation.networkId !== quote.recipient || !isStripeProfileId(operation.networkId) || !Object.hasOwn(config.sellers, operation.networkId) || !Number.isSafeInteger(expiry) || operation.expiresAt !== expiry ||
        challenge?.method !== 'stripe' || challenge.intent !== 'charge' || challenge.header !== 'Payment-Authorization' || challenge.expires !== quote.expiresAt ||
        challenge.request.amount !== quote.amount || challenge.request.currency !== 'usd' || challenge.request.recipient !== quote.recipient || challenge.request.externalId !== quote.quoteId ||
        details.networkId !== quote.recipient || digest(details.metadata ?? {}) !== digest(metadata) ||
        metadata.envarpay_quote !== quote.quoteId || metadata.envarpay_terms !== quote.termsDigest || typeof metadata.envarpay_order !== 'string' || !UUID.test(metadata.envarpay_order) ||
        typeof quote.quoteId !== 'string' || quote.quoteId.length > 500 || typeof quote.termsDigest !== 'string' || quote.termsDigest.length > 500 ||
        Challenge.serialize(challenge).length > 32768) throw new CommerceError('stripe_spt_binding', 'SPT request differs from the frozen purchase or approved funding scope');
    const body = new URLSearchParams({ payment_method: operation.paymentMethod,
      'usage_limits[currency]': 'usd', 'usage_limits[max_amount]': operation.amount, 'usage_limits[expires_at]': String(expiry),
      'shared_metadata[envarpay_operation]': operation.operationId, 'shared_metadata[envarpay_purchase]': operation.purchaseId,
      'shared_metadata[envarpay_order]': metadata.envarpay_order, 'shared_metadata[envarpay_quote]': quote.quoteId, 'shared_metadata[envarpay_terms]': quote.termsDigest,
    });
    if (issuance === 'issued-token') {
      body.set('seller_details[network_business_profile]', operation.networkId);
      if (config.returnUrl) body.set('return_url', config.returnUrl);
    }
    return { operation: structuredClone(operation), body: body.toString(), binding: { issuerAccountId: config.issuerAccountId, sellerAccountId: config.sellers[operation.networkId]!.accountId, issuance, ...(config.returnUrl ? { returnUrl: config.returnUrl } : {}) } };
  }
  function saved(row: IssuerRow): OriginalRequest {
    const original = vault.get(row.requestRef) as OriginalRequest;
    if (row.operationId !== original.operation?.operationId || digest(original) !== row.fingerprint || digest(requestFor(original.operation)) !== row.fingerprint) throw new CommerceError('stripe_spt_recovery_binding', 'Original issuer scope changed or failed integrity validation');
    return original;
  }
  function tokenId(row: IssuerRow): string {
    if (!row.tokenRef) throw new CommerceError('stripe_spt_recovery_required', 'Original SPT ID is unknown; do not issue a replacement token');
    const value = vault.get(row.tokenRef) as { operationId: string; fingerprint: string; id: string };
    if (value.operationId !== row.operationId || value.fingerprint !== row.fingerprint || !TOKEN.test(value.id)) throw new CommerceError('stripe_spt_recovery_binding', 'Original encrypted SPT binding is invalid');
    return value.id;
  }
  function validateToken(value: Json, original: OriginalRequest, expectedId: string): void {
    const operation = original.operation, limits = object(value.usage_limits), meta = object(value.shared_metadata);
    if (value.id !== expectedId || value.object !== (issuance === 'issued-token' ? 'shared_payment.issued_token' : 'shared_payment.granted_token') ||
        value.livemode !== (config.mode === 'live') || limits.currency !== 'usd' || !Number.isSafeInteger(limits.max_amount) || String(limits.max_amount) !== operation.amount || limits.expires_at !== operation.expiresAt ||
        meta.envarpay_operation !== operation.operationId || meta.envarpay_purchase !== operation.purchaseId || meta.envarpay_order !== operation.metadata!.envarpay_order || meta.envarpay_quote !== operation.quote.quoteId || meta.envarpay_terms !== operation.quote.termsDigest ||
        (issuance === 'issued-token' && (value.payment_method !== operation.paymentMethod || object(value.seller_details).network_business_profile !== operation.networkId)) ||
        (issuance === 'test-helper' && object(value.payment_method_details).type !== 'card')) throw new CommerceError('stripe_spt_response_binding', 'Stripe token does not match the original scope and mode');
  }
  function usable(value: Json, original: OriginalRequest): string {
    if (value.status === 'requires_action') throw new CommerceError('stripe_spt_requires_action', 'Original SPT requires customer authentication through Stripe.js');
    const captured = object(object(value.usage_details).amount_captured);
    if ((issuance === 'issued-token' && value.status !== 'active') || value.deactivated_at != null || value.deactivated_reason != null ||
        captured.value !== 0 || captured.currency !== 'usd' || original.operation.expiresAt <= Math.floor(now() / 1000)) throw new CommerceError('stripe_spt_unusable', 'Original SPT is expired, consumed, inactive or not proven unused');
    return String(value.id);
  }
  async function retrieve(row: IssuerRow): Promise<{ original: OriginalRequest; value: Json }> {
    const original = saved(row), id = tokenId(row);
    await account(config.secretKey, config.issuerAccountId);
    // Test helpers use the seller account itself; issued tokens use the issuer account.
    const value = await call(config.secretKey, `/v1/shared_payment/${issuance === 'issued-token' ? 'issued' : 'granted'}_tokens/${id}`);
    validateToken(value, original, id);
    return { original, value };
  }
  async function exclusive<T>(id: string, fn: () => Promise<T>): Promise<T> {
    if (inFlight.has(id)) throw new CommerceError('stripe_spt_operation_busy', 'Original SPT operation is already in progress');
    inFlight.add(id); try { return await fn(); } finally { inFlight.delete(id); }
  }
  const adapter: StripeMppBuyerAdapter = {
    payer: config.payer, mode: config.mode, paymentMethod: config.paymentMethod, issuance,
    async assertReady() {
      await account(config.secretKey, config.issuerAccountId);
      for (const profile of Object.keys(config.sellers)) await sellerReady(profile);
    },
    close() { ledger.close(); },
    async createToken(operation) {
      return exclusive(operation.operationId, async () => {
        const original = requestFor(operation), fingerprint = digest(original), prior = ledger.get(operation.operationId);
        if (prior) {
          if (prior.fingerprint !== fingerprint) throw new CommerceError('stripe_spt_recovery_binding', 'Operation ID is already bound to another SPT request');
          const result = await retrieve(prior); return usable(result.value, result.original);
        }
        if (operation.expiresAt <= Math.floor(now() / 1000) || operation.expiresAt > Math.floor(now() / 1000) + 3600) throw new CommerceError('stripe_spt_expiry', 'SPT expiry must be within the original one-hour quote window');
        await account(config.secretKey, config.issuerAccountId);
        await sellerReady(operation.networkId);
        if (operation.expiresAt <= Math.floor(now() / 1000)) throw new CommerceError('stripe_spt_expiry', 'Original quote expired during issuer readiness checks');
        // No await between durable insertion and starting the one permitted POST.
        const row = ledger.insert(operation, fingerprint, vault.put(original), now());
        const value = await call(config.secretKey, issuance === 'issued-token' ? '/v1/shared_payment/issued_tokens' : '/v1/test_helpers/shared_payment/granted_tokens', original.body, operation.idempotencyKey);
        if (typeof value.id !== 'string' || !TOKEN.test(value.id)) throw new CommerceError('stripe_spt_response_binding', 'Stripe did not return a valid original SPT ID');
        // Save the ID even if the remaining response needs independent reconciliation.
        ledger.token(row.operationId, vault.put({ operationId: row.operationId, fingerprint, id: value.id }));
        validateToken(value, original, value.id);
        return usable(value, original);
      });
    },
    async recoverToken(operation) {
      return exclusive(operation.operationId, async () => {
        const row = ledger.get(operation.operationId);
        if (!row) throw new CommerceError('stripe_spt_recovery_required', 'Original issuer operation is absent; do not issue a replacement token');
        if (digest(requestFor(operation)) !== row.fingerprint) throw new CommerceError('stripe_spt_recovery_binding', 'Recovery differs from the original SPT request');
        const result = await retrieve(row); return usable(result.value, result.original);
      });
    },
    async authenticationAction(operationId) {
      if (!OPERATION.test(operationId)) throw new CommerceError('stripe_spt_recovery_required', 'Original issuer operation is required');
      const row = ledger.get(operationId);
      if (!row) throw new CommerceError('stripe_spt_recovery_required', 'Original issuer operation is absent');
      const { value } = await retrieve(row);
      if (value.status !== 'requires_action') return undefined;
      const action = object(value.next_action), sdk = object(action.use_stripe_sdk);
      if (action.type !== 'use_stripe_sdk' || typeof sdk.value !== 'string' || !sdk.value || sdk.value.length > 16384) throw new CommerceError('stripe_spt_action_unsupported', 'Original SPT requires customer action not supported by this Stripe.js bridge');
      return { type: 'use_stripe_sdk', hashedValue: sdk.value };
    },
    async getAuthentication(context) {
      if (!OPERATION.test(context.operationId)) throw new CommerceError('stripe_spt_recovery_required', 'Original issuer operation is required');
      const row = ledger.get(context.operationId);
      if (!row) throw new CommerceError('stripe_spt_recovery_required', 'Original issuer operation is absent');
      const original = saved(row), op = original.operation;
      if (context.purchaseId !== op.purchaseId || context.mode !== config.mode || digest(context.quote) !== digest(op.quote)) {
        throw new CommerceError('stripe_spt_recovery_binding', 'Authentication differs from the original purchase');
      }
      const action = await adapter.authenticationAction(context.operationId);
      if (!action) return undefined;
      if (!config.publishableKey) throw new CommerceError('stripe_publishable_key_required', 'Configure the issuer publishable key to authenticate this original payment');
      return { ...action, publishableKey: config.publishableKey };
    },
    async verifyReceipt(receipt: MppReceipt, context: MppVerificationContext) {
      const row = ledger.get(context.operationId);
      if (!row?.tokenRef) return false;
      const original = saved(row), op = original.operation, seller = config.sellers[op.networkId]!;
      if (context.purchaseId !== op.purchaseId || context.mode !== config.mode || digest(context.quote) !== digest(op.quote) ||
          receipt.method !== 'stripe' || receipt.status !== 'success' || !/^pi_[A-Za-z0-9]{1,128}$/.test(receipt.reference) ||
          receipt.externalId !== op.quote.quoteId || receipt.amount !== op.amount || receipt.currency !== 'usd' || receipt.merchant !== op.networkId ||
          receipt.accountId !== seller.accountId || receipt.livemode !== (config.mode === 'live')) return false;
      await sellerReady(op.networkId);
      const intent = await call(seller.secretKey, `/v1/payment_intents/${receipt.reference}`);
      const metadata = object(intent.metadata);
      return intent.id === receipt.reference && intent.object === 'payment_intent' && intent.status === 'succeeded' && intent.livemode === (config.mode === 'live') &&
        Number.isSafeInteger(intent.amount) && String(intent.amount) === op.amount && Number.isSafeInteger(intent.amount_received) && String(intent.amount_received) === op.amount &&
        intent.currency === 'usd' && metadata.envarpay_order === op.metadata!.envarpay_order && metadata.envarpay_quote === op.quote.quoteId && metadata.envarpay_terms === op.quote.termsDigest;
    },
  };
  return adapter;
}
