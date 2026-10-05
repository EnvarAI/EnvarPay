import { findDefaultAsset } from '@x402/evm';
import { x402ResourceServer, type FacilitatorClient, HTTPFacilitatorClient } from '@x402/core/server';
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from '@x402/core/http';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import {
  PAYMENT_IDENTIFIER, declarePaymentIdentifierExtension, extractPaymentIdentifier,
  validatePaymentIdentifier, paymentIdentifierResourceServerExtension,
} from '@x402/extensions/payment-identifier';
import type { PaymentPayload, PaymentRequired, PaymentRequirements, SettleResponse } from '@x402/core/types';
import { CommerceError, type PaymentProfile } from './types.js';
import { CommerceStore, type OrderRecord } from './store.js';
import { CredentialVault } from './vault.js';
import { digest } from './config.js';

type X402Profile = Extract<PaymentProfile, { adapter: 'x402' }>;
interface SavedAuthorization {
  payload: PaymentPayload;
  requirements: PaymentRequirements;
  quoteId: string;
  fromBlock?: string;
}
export interface X402GateOptions {
  store: CommerceStore;
  vault: CredentialVault;
  payerFor: (caller: string) => string | undefined;
  facilitator?: (profile: X402Profile) => FacilitatorClient;
  verifyReceipt: (receipt: SettleResponse, payload: PaymentPayload, requirements: PaymentRequirements) => Promise<boolean>;
  /** Read chain before broadcast, so a lost facilitator response remains recoverable. */
  checkpoint?: (requirements: PaymentRequirements) => Promise<string>;
  findOriginalReceipt?: (payload: PaymentPayload, requirements: PaymentRequirements, fromBlock: string) => Promise<SettleResponse | undefined>;
  proveExpiredUnused?: (payload: PaymentPayload, requirements: PaymentRequirements) => Promise<boolean>;
}
export type GateResult = { response: Response } | { headers: Record<string, string> };

/** Official x402 v2 exact settlement, with independent chain evidence before work. */
export class X402Gate {
  private servers = new Map<string, Promise<{ server: x402ResourceServer; facilitator: FacilitatorClient }>>();
  constructor(private options: X402GateOptions) {}

  async check(profiles:readonly X402Profile[]):Promise<void> {
    for(const profile of profiles){
      const {facilitator}=await this.resource(profile);
      const supported=await facilitator.getSupported();
      if(!supported.kinds.some(k=>k.x402Version===2&&k.scheme==='exact'&&k.network===profile.network))throw new CommerceError('facilitator_network','Configured facilitator does not support exact payments on this network');
      if(this.options.checkpoint)await this.options.checkpoint({scheme:'exact',network:profile.network as `eip155:${string}`,asset:profile.asset,payTo:profile.payTo,amount:'1',maxTimeoutSeconds:300,extra:{}});
    }
  }

  async recover(orderId: string, caller: string): Promise<{ state: string; taskId: string }> {
    const order = this.options.store.getOrder(orderId, caller);
    if (!order) throw new CommerceError('order_not_found', 'Order not found for this buyer');
    const attempt = this.options.store.paymentForOrder(order.id);
    if (!attempt) throw new CommerceError('attempt_not_found', 'No original payment to recover');
    if (attempt.state === 'confirmed') return { state: 'confirmed', taskId: order.taskId };
    if (attempt.state === 'rejected') return { state: 'rejected', taskId: order.taskId };
    const saved = this.options.vault.get(attempt.credentialRef) as SavedAuthorization;
    const required = this.options.store.paymentChallenge<PaymentRequired>(order.id);
    if (saved.quoteId !== order.quote.quoteId || !required?.accepts.some(r => digest(r) === digest(saved.requirements))) {
      throw new CommerceError('recovery_conflict', 'Stored authorization differs from the frozen challenge');
    }
    let receipt = attempt.receipt as SettleResponse | null;
    if (!receipt?.transaction && saved.fromBlock && this.options.findOriginalReceipt) {
      receipt = await this.options.findOriginalReceipt(saved.payload, saved.requirements, saved.fromBlock) ?? null;
    }
    if (!receipt?.transaction) {
      if (await this.options.proveExpiredUnused?.(saved.payload, saved.requirements)) {
        this.options.store.recordSettlement(attempt.id, 'rejected', {errorReason:'authorization_expired_unused'});
        return {state:'rejected',taskId:order.taskId};
      }
      return { state: 'unknown', taskId: order.taskId };
    }
    let proven = false;
    try { proven = await this.options.verifyReceipt(receipt, saved.payload, saved.requirements); } catch {}
    // Persist the discovered transaction even if confirmations are still pending.
    this.options.store.recordSettlement(attempt.id, proven ? 'confirmed' : 'unknown', receipt);
    return { state: proven ? 'confirmed' : 'unknown', taskId: order.taskId };
  }

  private async resource(profile: X402Profile) {
    const key = digest(profile);
    let promise = this.servers.get(key);
    if (!promise) {
      promise = (async () => {
        const facilitator = this.options.facilitator?.(profile) ?? new HTTPFacilitatorClient({ url: profile.facilitatorUrl });
        const server = new x402ResourceServer(facilitator)
          .register(profile.network as `eip155:${string}`, new ExactEvmScheme())
          .registerExtension(paymentIdentifierResourceServerExtension);
        await server.initialize();
        return { server, facilitator };
      })();
      this.servers.set(key, promise);
      void promise.catch(() => this.servers.delete(key));
    }
    return promise;
  }

  async handle(request: Request, order: OrderRecord): Promise<GateResult> {
    const profile = order.quote.paymentProfile;
    if (profile?.adapter !== 'x402') throw new CommerceError('payment_method_unavailable', 'This offer requires another installed payment adapter');
    const previous = this.options.store.paymentForOrder(order.id);
    if (order.paymentState === 'confirmed' && previous?.receipt) {
      return { headers: { 'PAYMENT-RESPONSE': encodePaymentResponseHeader(previous.receipt as SettleResponse) } };
    }
    if (['settling', 'unknown'].includes(order.paymentState)) {
      const recovered=await this.recover(order.id,order.caller);
      if(recovered.state==='confirmed'){const receipt=this.options.store.paymentForOrder(order.id)!.receipt!;return {headers:{'PAYMENT-RESPONSE':encodePaymentResponseHeader(receipt as SettleResponse)}};}
      return { response: Response.json({ error: 'payment_reconciliation_required', taskId: order.taskId }, { status: 503, headers: { 'Cache-Control': 'no-store' } }) };
    }
    if (Date.now() >= Date.parse(order.quote.expiresAt)) return { response: Response.json({ error: 'quote_expired' }, { status: 409 }) };
    const { server, facilitator } = await this.resource(profile);
    let required = this.options.store.paymentChallenge<PaymentRequired>(order.id);
    if (!required) {
      const token=findDefaultAsset(profile.asset,profile.network as `eip155:${string}`);
      if(!token)throw new CommerceError('unsupported_asset','Official token signing domain is unavailable');
      const requirements = await server.buildPaymentRequirements({
        scheme: 'exact', network: profile.network as `eip155:${string}`, payTo: profile.payTo,
        price: { asset: profile.asset, amount: order.quote.amount, extra: { name: token.name, version: token.version } },
        maxTimeoutSeconds: 300, extra: { paymentFlow: 'upfront', assetTransferMethod: 'eip3009' },
      });
      const resource = new URL(request.url);
      resource.search = ''; resource.searchParams.set('quote', order.quote.quoteId);
      required = this.options.store.freezePaymentChallenge(order.id, await server.createPaymentRequiredResponse(
        requirements, { url: resource.href, description: order.quote.serviceId, mimeType: 'application/json' },
        undefined, { [PAYMENT_IDENTIFIER]: declarePaymentIdentifierExtension(false), 'urn:envarpay:quote:1': {info:{quoteId:order.quote.quoteId,messageId:order.messageId,serviceId:order.quote.serviceId,serviceRevision:order.quote.serviceRevision,offerId:order.offerId,inputDigest:order.inputDigest,termsDigest:order.quote.termsDigest,expiresAt:order.quote.expiresAt,amount:order.quote.amount,currency:order.quote.currency,recipient:order.quote.recipient}} },
      ));
    }
    // Identifier is optional for unextended standard clients; nonce dedup is mandatory.
    const challenge = (): GateResult => ({ response: new Response('{}', {
      status: 402, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'PAYMENT-REQUIRED': encodePaymentRequiredHeader(required!) },
    }) });
    const header = request.headers.get('PAYMENT-SIGNATURE');
    if (!header) return challenge();
    if (header.length > 32768) throw new CommerceError('payment_payload_size', 'Payment credential exceeds limit');
    let payload: PaymentPayload;
    try { payload = decodePaymentSignatureHeader(header); } catch { throw new CommerceError('invalid_payment', 'Malformed payment credential'); }
    const matched = server.findMatchingRequirements(required.accepts, payload);
    if (!matched || payload.x402Version !== 2 || payload.resource?.url !== required.resource.url || digest(payload.accepted) !== digest(matched)) {
      throw new CommerceError('quote_mismatch', 'Payment does not match the frozen quote');
    }
    const extension = payload.extensions?.[PAYMENT_IDENTIFIER] as {info?:unknown}|undefined;
    // Validate against our schema; never compile a schema supplied by the buyer.
    if (extension !== undefined && !validatePaymentIdentifier({info:extension?.info,schema:declarePaymentIdentifierExtension(false).schema}).valid) {
      throw new CommerceError('invalid_payment_identifier', 'Invalid standard payment identifier');
    }
    const identifier = extractPaymentIdentifier(payload, false);
    const native = payload.payload as { authorization?: { from?: string; to?: string; value?: string; nonce?: string }; signature?: string };
    const auth = native.authorization;
    const payer = this.options.payerFor(order.caller);
    if (!payer || !auth?.from || auth.from.toLowerCase() !== payer.toLowerCase() || auth.to?.toLowerCase() !== profile.payTo.toLowerCase() || auth.value !== order.quote.amount || !/^0x[0-9a-fA-F]{64}$/.test(auth.nonce ?? '') || !native.signature) {
      throw new CommerceError('payment_identity', 'Signed payer, recipient, amount and nonce must match authorized buyer and quote');
    }
    // Quote UI metadata is locally checked above. It is not a facilitator
    // settlement extension; do not require third-party facilitators to implement it.
    const settlementPayload:PaymentPayload={...payload,extensions:Object.fromEntries(Object.entries(payload.extensions??{}).filter(([key])=>key!=='urn:envarpay:quote:1'))};
    // Upfront SDK verification may skip /verify; explicitly perform it before reserve.
    const verified = await facilitator.verify(settlementPayload, matched);
    if (!verified.isValid) return challenge();
    if (verified.payer && verified.payer.toLowerCase() !== payer.toLowerCase()) throw new CommerceError('payment_identity', 'Verified payer differs from authorized buyer');
    const economicKey = digest({ network: profile.network, asset: profile.asset.toLowerCase(), payer: payer.toLowerCase(), nonce: auth.nonce!.toLowerCase() });
    const fromBlock = await this.options.checkpoint?.(matched);
    const saved: SavedAuthorization = { payload, requirements: matched, quoteId: order.quote.quoteId, ...(fromBlock !== undefined ? { fromBlock } : {}) };
    const credentialRef = this.options.vault.put(saved);
    const attempt = this.options.store.reservePayment(order.id, order.caller, economicKey, credentialRef, identifier ?? undefined);
    let result: SettleResponse;
    try { result = await server.settlePayment(settlementPayload, matched, undefined, undefined, undefined, 'before-handler'); }
    catch {
      this.options.store.recordSettlement(attempt, 'unknown', {});
      return { response: Response.json({ error: 'payment_outcome_unknown' }, { status: 503 }) };
    }
    // A failure can follow broadcast. Never create a second economic authorization.
    let proven = false;
    if (result.success) { try { proven = await this.options.verifyReceipt(result, payload, matched); } catch {} }
    this.options.store.recordSettlement(attempt, proven ? 'confirmed' : 'unknown', result);
    if (!proven) return { response: Response.json({ error: result.success ? 'receipt_verification_pending' : 'payment_outcome_unknown' }, { status: 503 }) };
    return { headers: { 'PAYMENT-RESPONSE': encodePaymentResponseHeader(result) } };
  }
}
