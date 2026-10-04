import { findDefaultAsset } from '@x402/evm';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { AgentCard, SendMessageRequest, GetTaskRequest, Task, TaskState, Message, Role } from '@a2a-js/sdk';
import { ClientFactory, JsonRpcTransportFactory } from '@a2a-js/sdk/client';
import { x402Client } from '@x402/core/client';
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from '@x402/core/http';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import type { ClientEvmSigner } from '@x402/evm';
import type { PaymentPayload, PaymentRequired, PaymentRequirements, SettleResponse } from '@x402/core/types';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsImport from 'ajv-formats';
import { atomic, digest, loadBuyerPolicy, validateUrl } from './config.js';
import { CommerceError, type BuyerPolicy, type Input, type Pricing, type StandardA2APeer } from './types.js';
import { CredentialVault } from './vault.js';
import { BuyerStore, type BuyerRecord, type BuyerQuote } from './buyer-store.js';
import { Challenge, Receipt, PaymentRequest } from 'mppx';
import { assertMppDigest, isStripeTestPaymentMethod, prepareMppCredential, publicMppReceipt, validateMppCredential, type MppAuthenticationAction, type MppBuyerOptions, type MppReceipt, type MppTokenOperation, type SavedMppAuthorization, type SavedMppToken } from './mpp-client.js';

const COMMERCE = 'urn:envarpay:commerce:1', QUOTE = 'urn:envarpay:quote:1';
const addFormats = addFormatsImport as unknown as (ajv: Ajv2020) => void;
type Peer = BuyerPolicy['peers'][number];
interface AdvertisedOffer {
  serviceId: string; serviceRevision: number; offerId: string; pricing: Pricing;
  collection: { kind: string }; contract: { inputSchema: Record<string, unknown> };
  payment: { adapter: string; network?: string; asset?: string; payTo?: string; method?: string; intent?: string; currency?: string } | null;
  termsDigest: string;
}
interface SavedAuthorization { payload: PaymentPayload; requirements: PaymentRequirements; fingerprint: string; }
export interface BuyerPreviewInput { cardUrl: string; messageId: string; input: Input; offerId: string; }
export interface BuyerConfirmInput { previewId: string; quoteToken: string; messageId: string; }
export interface BuyerAuthentication { purchaseId: string; action: MppAuthenticationAction | null; }
export interface CommerceBuyerOptions {
  policy: BuyerPolicy; store: BuyerStore; vault?: CredentialVault; signer?: ClientEvmSigner; mpp?: MppBuyerOptions;
  peerTokens: Readonly<Record<string, string>>;
  /** Override sibling /a2a only when the local wallet owner explicitly allows it. */
  peerEndpoints?: Readonly<Record<string, string>>;
  verifyReceipt?: (receipt: SettleResponse, payload: PaymentPayload, requirements: PaymentRequirements) => Promise<boolean>;
  checkpoint?: (requirements: PaymentRequirements) => Promise<string>;
  proveExpiredUnused?: (payload: PaymentPayload, requirements: PaymentRequirements) => Promise<boolean>;
  findOriginalReceipt?: (payload: PaymentPayload, requirements: PaymentRequirements, fromBlock: string) => Promise<SettleResponse | undefined>;
  fetchImpl?: typeof fetch;
}
export interface BuyerSnapshot {
  id: string; quoteToken: string; messageId: string; payer: string; state: string;
  quote: BuyerQuote; paymentState: string; executionState: string;
  task?: Record<string, unknown>; result?: unknown; errorCode?: string;
  continuation?: { messageId: string; state: 'pending' | 'unknown' | 'resolved'; input: Input };
  receipt?: SettleResponse | MppReceipt; nonce?: string; createdAt: string; updatedAt: string;
}

async function bounded(response: Response, limit = 4 * 1024 * 1024): Promise<Response> {
  if (Number(response.headers.get('Content-Length') ?? 0) > limit) { await response.body?.cancel(); throw new CommerceError('response_too_large', 'Peer response exceeds the configured limit'); }
  const chunks: Uint8Array[] = []; let length = 0;
  if (response.body) {
    const reader = response.body.getReader();
    for (;;) { const next = await reader.read(); if (next.done) break; length += next.value.byteLength; if (length > limit) { await reader.cancel(); throw new CommerceError('response_too_large', 'Peer response exceeds the configured limit'); } chunks.push(next.value); }
  }
  return new Response(chunks.length ? Buffer.concat(chunks) : null, { status: response.status, statusText: response.statusText, headers: response.headers });
}
function inputAmount(offer: AdvertisedOffer, input: Input): string {
  const ajv = new Ajv2020({ strict: true }); addFormats(ajv);
  const validate = ajv.compile(offer.contract.inputSchema);
  if (!validate(input)) throw new CommerceError('invalid_input', 'Input does not satisfy the advertised service schema');
  if (offer.pricing.kind === 'fixed') return atomic(offer.pricing.amount).toString();
  if (offer.pricing.kind !== 'quantity') throw new CommerceError('free_preview_unsupported', 'This payment preview supports explicitly priced upfront offers only');
  const q = offer.pricing.quantity; let value: unknown = input;
  if (q.measure !== 'count' || !q.pointer.startsWith('/') || !Number.isSafeInteger(q.min) || !Number.isSafeInteger(q.max) || q.min < 1 || q.max < q.min) throw new CommerceError('invalid_offer', 'Invalid quantity pricing');
  for (const part of q.pointer.slice(1).split('/')) { const key = part.replace(/~1/g, '/').replace(/~0/g, '~'); value = value && typeof value === 'object' && Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined; }
  if (!Array.isArray(value) || value.length < q.min || value.length > q.max) throw new CommerceError('invalid_quantity', 'Input quantity is outside the advertised bounds');
  return atomic((atomic(offer.pricing.unitAmount) * BigInt(value.length)).toString()).toString();
}
function noExternalRefs(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) { if (['$ref', '$dynamicRef'].includes(key) && (typeof child !== 'string' || !child.startsWith('#'))) throw new CommerceError('external_schema_ref', 'External service schema references are unsupported'); noExternalRefs(child); }
}
function standardPolicyDigest(peer: StandardA2APeer): string {
  return digest({ mode: peer.mode, cardUrl: peer.cardUrl, endpoint: peer.endpoint, authentication: peer.authentication,
    protocol: peer.protocol, currency: peer.currency, recipient: peer.recipient, localContract: peer.localContract });
}
function standardRequirements(peer: StandardA2APeer, required: PaymentRequired): PaymentRequirements {
  let resource: URL;
  try { resource = new URL(required.resource?.url ?? ''); } catch { throw new CommerceError('quote_mismatch', 'Standard payment resource must name the approved A2A endpoint'); }
  const candidates = Array.isArray(required.accepts) ? required.accepts.filter(r => {
    if (!r || r.scheme !== 'exact' || typeof r.asset !== 'string' || typeof r.payTo !== 'string' || `${r.network}/erc20:${r.asset.toLowerCase()}` !== peer.currency || r.payTo.toLowerCase() !== peer.recipient || r.amount !== peer.localContract.amount || !Number.isInteger(r.maxTimeoutSeconds) || r.maxTimeoutSeconds < 1 || r.maxTimeoutSeconds > 300) return false;
    const asset = findDefaultAsset(r.asset, r.network), extra = r.extra;
    return !!asset && !!extra && typeof extra === 'object' && !Array.isArray(extra)
      && (extra.assetTransferMethod === undefined || extra.assetTransferMethod === 'eip3009')
      && (extra.paymentFlow === undefined || extra.paymentFlow === 'upfront')
      && extra.name === asset.name && extra.version === asset.version;
  }) : [];
  if (required.x402Version !== 2 || resource.href !== peer.endpoint || resource.username || resource.password || resource.hash || candidates.length !== 1) throw new CommerceError('quote_mismatch', 'Native challenge differs from the exact locally approved resource, price, asset, payee or timeout');
  return candidates[0]!;
}

/** Independent x402 wallet; payment and execution state are deliberately separate. */
export class CommerceBuyer {
  readonly policy: BuyerPolicy;
  private readonly fetchImpl: typeof fetch;
  private readonly active = new Map<string, Promise<BuyerSnapshot>>();
  private timer?: ReturnType<typeof setInterval>;
  private readonly previews = new Map<string, Promise<BuyerSnapshot>>();
  constructor(private readonly options: CommerceBuyerOptions) {
    this.policy = loadBuyerPolicy(options.policy);
    if(this.policy.peers.some(peer=>peer.protocol!=='free')&&!options.vault)throw new CommerceError('vault_required','Paid purchases need a private authorization vault'); this.fetchImpl = options.fetchImpl ?? fetch;
    if (this.policy.peers.some(p => p.protocol === 'x402') && (!options.signer || !/^0x[0-9a-fA-F]{40}$/.test(options.signer.address) || BigInt(options.signer.address) === 0n || !options.verifyReceipt)) throw new CommerceError('invalid_signer', 'x402 peers require an EVM wallet and independent receipt verifier');
    if (this.policy.peers.some(p => p.protocol === 'mpp') && (!options.mpp || !options.mpp.payer || !(/^pm_[A-Za-z0-9]+$/.test(options.mpp.paymentMethod) || (options.mpp.mode==='test'&&options.mpp.issuance==='test-helper'&&isStripeTestPaymentMethod(options.mpp.paymentMethod))) || !['test','live'].includes(options.mpp.mode) || typeof options.mpp.createToken !== 'function' || typeof options.mpp.verifyReceipt !== 'function')) throw new CommerceError('mpp_provider_missing', 'MPP peers require explicit token creation and independent provider verification');
    for (const peer of this.policy.peers) if (!(peer.mode === 'standard-a2a' && peer.authentication === 'none') && (!options.peerTokens[peer.id] || options.peerTokens[peer.id]!.length < 16)) throw new CommerceError('peer_credentials', 'Each authenticated peer needs its own authentication token');
  }
  /** Background observation only; never signs, replays credentials or changes reservations. */
  start(intervalMs = 2000): void {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 100) throw new CommerceError('poll_interval', 'Observation interval must be at least 100ms');
    if (this.timer) return;
    this.timer = setInterval(() => {
      for (const record of this.options.store.pendingTasks()) {
        if (!this.active.has(record.id)) void this.exclusive(record.id, () => this.observe(record)).catch(() => undefined);
      }
    }, intervalMs);
    this.timer.unref();
  }
  async stop(): Promise<void> { if (this.timer) clearInterval(this.timer); this.timer = undefined; await Promise.allSettled([...this.active.values()]); }
  policySnapshot() {
    return { ...structuredClone(this.policy), capabilities: [...new Set(this.policy.peers.map(peer => peer.protocol))], state: this.policy.paymentsEnabled || this.policy.peers.some(peer => peer.protocol === 'free') ? 'ready' : 'disabled', payer: this.options.signer?.address ?? this.options.mpp?.payer, budgets: this.policy.budgets.map(b => ({ ...b, ...this.options.store.usage(b.currency) })) };
  }
  private peer(cardUrl: string): Peer {
    const parsed = validateUrl(cardUrl);
    const matches = this.policy.peers.filter(p => p.cardUrl === parsed.href && p.cardUrl === cardUrl);
    if (matches.length !== 1) throw new CommerceError('peer_not_allowed', 'An exact, unambiguous Card URL must be approved locally');
    return matches[0]!;
  }
  private endpoint(peer: Peer): string {
    const explicit = this.options.peerEndpoints?.[peer.id];
    if (peer.mode === 'standard-a2a') {
      if (explicit && explicit !== peer.endpoint) throw new CommerceError('endpoint_policy', 'A standard peer endpoint must match its locally reviewed policy');
      return peer.endpoint;
    }
    const card = new URL(peer.cardUrl);
    if (!explicit && (!card.pathname.endsWith('/agent-card.json') || card.search)) throw new CommerceError('endpoint_policy', 'Configure an explicit peer endpoint for this Agent Card URL');
    const endpoint = validateUrl(explicit ?? new URL('./a2a', card).href);
    if (endpoint.origin !== card.origin || endpoint.search) throw new CommerceError('endpoint_policy', 'Allowed peer endpoint must stay on its Card origin and have no query');
    return endpoint.href;
  }
  private scopedFetch(peer: Peer, endpoint: string): typeof fetch {
    return async (input, init) => {
      const request = new Request(input, init);
      if (![peer.cardUrl, endpoint].includes(request.url)) throw new CommerceError('peer_scope', 'Peer request escaped the locally approved endpoint');
      if ((request.url === peer.cardUrl && request.method !== 'GET') || (request.url === endpoint && request.method !== 'POST')) throw new CommerceError('peer_scope', 'Unsupported peer operation');
      const headers = new Headers(request.headers);
      if (peer.mode === 'standard-a2a' && peer.authentication === 'none') headers.delete('Authorization');
      else headers.set('Authorization', `Bearer ${this.options.peerTokens[peer.id]}`);
      headers.set('A2A-Version', '1.0');
      const response = await this.fetchImpl(new Request(request, { headers, redirect: 'error', signal: AbortSignal.any([request.signal, AbortSignal.timeout(30000)]) }));
      if (response.status >= 300 && response.status < 400) throw new CommerceError('peer_redirect', 'Peer redirects are not allowed');
      return bounded(response, request.method === 'GET' ? 512 * 1024 : 4 * 1024 * 1024);
    };
  }
  private record(caller: string, id: string): BuyerRecord {
    const record = this.options.store.get(id, caller);
    if (!record) throw new CommerceError('purchase_not_found', 'Purchase not found for this caller');
    return record;
  }
  private snapshot(record: BuyerRecord): BuyerSnapshot {
    return structuredClone({ id: record.id, quoteToken: record.quoteToken, messageId: record.messageId, payer: record.quote.payer, state: record.state, quote: record.quote, paymentState: record.paymentState, executionState: record.executionState, ...(record.task ? { task: record.task } : {}), ...(record.result !== undefined ? { result: record.result } : {}), ...(record.errorCode ? { errorCode: record.errorCode } : {}), ...(record.receipt ? { receipt: record.protocol === 'mpp' ? publicMppReceipt(record.receipt as MppReceipt) : { success: (record.receipt as SettleResponse).success, transaction: (record.receipt as SettleResponse).transaction, network: (record.receipt as SettleResponse).network, ...((record.receipt as SettleResponse).payer ? { payer: (record.receipt as SettleResponse).payer } : {}) } } : {}), ...(record.nonce ? { nonce: record.nonce } : {}), ...(record.continuations?.length ? { continuation: { messageId: record.continuations.at(-1)!.messageId, state: record.continuations.at(-1)!.state, input: record.continuations.at(-1)!.input } } : {}), createdAt: record.createdAt, updatedAt: record.updatedAt });
  }
  get(caller: string, id: string): BuyerSnapshot { return this.snapshot(this.record(caller, id)); }
  async preview(caller: string, input: BuyerPreviewInput): Promise<BuyerSnapshot> {
    if (!caller || caller.length > 256 || typeof input.messageId !== 'string' || !input.messageId || input.messageId.length > 128 || typeof input.offerId !== 'string' || !input.offerId || !input.input || typeof input.input !== 'object' || Array.isArray(input.input)) throw new CommerceError('invalid_purchase', 'Caller, stable message ID, offer and object input are required');
    const fingerprint = digest(input); const key = input.messageId;
    this.options.store.assertMessageOwner(caller, input.messageId);
    const existing = this.options.store.find(caller, input.messageId);
    if (existing) { if (existing.fingerprint !== fingerprint) throw new CommerceError('purchase_conflict', 'Message ID already identifies another purchase'); return this.snapshot(existing); }
    const active = this.previews.get(key);
    if (active) { await active; return this.preview(caller, input); }
    const pending = this.prepare(caller, input, fingerprint); this.previews.set(key, pending);
    try { return await pending; } finally { this.previews.delete(key); }
  }
  private async prepare(caller: string, input: BuyerPreviewInput, fingerprint: string): Promise<BuyerSnapshot> {
    const peer = this.peer(input.cardUrl), endpoint = this.endpoint(peer), scoped = this.scopedFetch(peer, endpoint);
    const response = await scoped(peer.cardUrl);
    if (!response.ok) throw new CommerceError('peer_card', 'Unable to read allowed Agent Card');
    const card = AgentCard.fromJSON(await response.json());
    if (!card.supportedInterfaces.some(i => i.protocolVersion === '1.0' && i.protocolBinding === 'JSONRPC' && i.url === endpoint)) throw new CommerceError('peer_interface', 'Agent Card must expose the approved A2A 1.0 JSONRPC endpoint');
    if (peer.mode === 'standard-a2a') return this.prepareStandard(caller, input, fingerprint, peer, card);
    if (card.supportedInterfaces.some(i => i.url !== endpoint)) throw new CommerceError('peer_interface', 'Agent Card must expose only the approved A2A 1.0 JSONRPC endpoint');
    const advertised = card.capabilities?.extensions.find(e => e.uri === COMMERCE)?.params as unknown as AdvertisedOffer | undefined;
    if (!advertised || advertised.offerId !== input.offerId || !advertised.serviceId || !Number.isSafeInteger(advertised.serviceRevision) || advertised.serviceRevision < 1 || !/^[0-9a-f]{64}$/.test(advertised.termsDigest ?? '') || !advertised.contract?.inputSchema || (peer.protocol !== 'free' && (advertised.collection?.kind !== 'upfront' || advertised.payment?.adapter !== peer.protocol))) throw new CommerceError('offer_metadata_required', 'Informed preview requires explicit paid offer terms in the Agent Card');
    if (peer.protocol === 'free') return this.prepareFree(caller, input, fingerprint, peer, endpoint, advertised);
    const payment = advertised.payment!;
    if (peer.protocol === 'x402' && (`${payment.network}/erc20:${payment.asset?.toLowerCase()}` !== peer.currency || payment.payTo?.toLowerCase() !== peer.recipient)) throw new CommerceError('payment_policy', 'Advertised payment differs from local wallet policy');
    if (peer.protocol === 'mpp' && (payment.method !== 'stripe' || payment.intent !== 'charge' || payment.currency !== 'usd')) throw new CommerceError('payment_policy', 'Advertised MPP method differs from local wallet policy');
    noExternalRefs(advertised.contract.inputSchema);
    const amount = inputAmount(advertised, input.input);
    if (atomic(amount) > atomic(peer.maxPerPurchase)) throw new CommerceError('purchase_limit', 'Advertised price exceeds the per-purchase limit');
    let originalBody = '', challenge: PaymentRequired | undefined, mppChallenge: Challenge.Challenge | undefined;
    const capture: typeof fetch = async (request, init) => {
      const req = new Request(request, init); originalBody = await req.clone().text();
      if (Buffer.byteLength(originalBody) > 1024 * 1024) throw new CommerceError('request_too_large', 'Purchase input exceeds 1 MiB');
      const result = await scoped(req);
      if (result.status !== 402) throw new CommerceError('paid_quote_required', 'Preview requires a payment challenge before execution');
      if (peer.protocol === 'mpp') {
        const header = result.headers.get('WWW-Authenticate');
        if (!header || header.length > 65536) throw new CommerceError('invalid_challenge', 'Missing or oversized MPP challenge');
        mppChallenge = Challenge.fromResponse(result);
        throw new CommerceError('preview_captured', 'MPP challenge captured');
      }
      const header = result.headers.get('PAYMENT-REQUIRED');
      if (!header || header.length > 65536) throw new CommerceError('invalid_challenge', 'Missing or oversized payment challenge');
      challenge = decodePaymentRequiredHeader(header);
      throw new CommerceError('preview_captured', 'Payment challenge captured');
    };
    const client = await new ClientFactory({ transports: [new JsonRpcTransportFactory({ fetchImpl: capture })] }).createFromAgentCard(card);
    try { await client.sendMessage(SendMessageRequest.fromJSON({ message: { messageId: input.messageId, role: 'ROLE_USER', parts: [{ data: input.input }] }, configuration: { returnImmediately: true } })); }
    catch (error) { if (!challenge && !mppChallenge) throw error; }
    if (peer.protocol === 'mpp' && mppChallenge && originalBody) return this.prepareMpp(caller, input, fingerprint, peer, endpoint, advertised, amount, originalBody, mppChallenge);
    if (!challenge || !originalBody) throw new CommerceError('invalid_challenge', 'Peer did not return a bound payment quote');
    const required = challenge, candidates = required.accepts?.filter(r => r.scheme === 'exact' && `${r.network}/erc20:${r.asset.toLowerCase()}` === peer.currency && r.payTo.toLowerCase() === peer.recipient && r.amount === amount && Number.isInteger(r.maxTimeoutSeconds) && r.maxTimeoutSeconds > 0 && r.maxTimeoutSeconds <= 300 && r.extra?.paymentFlow === 'upfront' && r.extra?.assetTransferMethod === 'eip3009' && r.extra?.name === findDefaultAsset(r.asset,r.network)?.name && r.extra?.version === findDefaultAsset(r.asset,r.network)?.version);
    const quote = (required.extensions?.[QUOTE] as { info?: BuyerQuote } | undefined)?.info;
    const resource = new URL(required.resource?.url ?? 'https://invalid.invalid');
    const expires = Date.parse(quote?.expiresAt ?? '');
    if (required.x402Version !== 2 || candidates?.length !== 1 || resource.origin + resource.pathname !== endpoint || resource.searchParams.get('quote') !== quote?.quoteId || [...resource.searchParams.keys()].some(k => k !== 'quote') || !quote || quote.messageId !== input.messageId || quote.inputDigest !== digest(input.input) || quote.termsDigest !== advertised.termsDigest || quote.serviceId !== advertised.serviceId || quote.serviceRevision !== advertised.serviceRevision || quote.offerId !== input.offerId || quote.amount !== amount || quote.currency !== peer.currency || quote.recipient?.toLowerCase() !== peer.recipient || !Number.isFinite(expires) || expires <= Date.now() || expires > Date.now() + 3600000) throw new CommerceError('quote_mismatch', 'Native payment quote differs from the advertised purchase or local wallet policy');
    const frozenQuote: BuyerQuote = {
      quoteId: quote.quoteId, messageId: input.messageId, payer: this.options.signer!.address.toLowerCase(),
      amount, currency: peer.currency, recipient: peer.recipient, expiresAt: quote.expiresAt,
      serviceId: quote.serviceId, serviceRevision: quote.serviceRevision, offerId: quote.offerId,
      inputDigest: quote.inputDigest, termsDigest: quote.termsDigest,
    };
    return this.snapshot(this.options.store.insert({ protocol: 'x402', caller, peerId: peer.id, cardUrl: peer.cardUrl, endpoint, messageId: input.messageId, fingerprint, input: structuredClone(input.input), inputSchema: structuredClone(advertised.contract.inputSchema), body: originalBody, quoteToken: randomBytes(32).toString('base64url'), quote: frozenQuote, required, requirements: candidates[0]! }));
  }
  private async prepareStandard(caller: string, input: BuyerPreviewInput, fingerprint: string, peer: StandardA2APeer, card: AgentCard): Promise<BuyerSnapshot> {
    const contract = peer.localContract;
    if (card.securityRequirements.length && !card.securityRequirements.some(requirement => {
      const names = Object.keys(requirement.schemes);
      if (!names.length) return true;
      if (peer.authentication !== 'bearer' || names.length !== 1) return false;
      const name = names[0]!, scheme = card.securitySchemes[name]?.scheme;
      return scheme?.$case === 'httpAuthSecurityScheme' && scheme.value.scheme.toLowerCase() === 'bearer' && !requirement.schemes[name]!.list.length;
    })) throw new CommerceError('peer_authentication', 'Agent Card authentication is not satisfied by the locally approved none/bearer mode');
    if (input.offerId !== contract.offerId) throw new CommerceError('offer_not_allowed', 'Select the locally reviewed standard-peer offer');
    const ajv = new Ajv2020({ strict: true }); addFormats(ajv);
    if (!ajv.compile(contract.inputSchema)(input.input)) throw new CommerceError('invalid_input', 'Input does not satisfy the locally reviewed schema');
    const amount = atomic(contract.amount).toString();
    if (atomic(amount) > atomic(peer.maxPerPurchase)) throw new CommerceError('purchase_limit', 'Local price exceeds the per-purchase limit');
    let body = '', required: PaymentRequired | undefined;
    const capture: typeof fetch = async (value, init) => {
      const request = new Request(value, init); body = await request.clone().text();
      if (Buffer.byteLength(body) > 1024 * 1024) throw new CommerceError('request_too_large', 'Purchase input exceeds 1 MiB');
      const response = await this.scopedFetch(peer, peer.endpoint)(request);
      if (response.status !== 402) throw new CommerceError('paid_quote_required', 'The operator-approved paid-only endpoint must return 402 before any authorization');
      const header = response.headers.get('PAYMENT-REQUIRED');
      if (!header || header.length > 65536) throw new CommerceError('invalid_challenge', 'Missing or oversized native x402 challenge');
      required = decodePaymentRequiredHeader(header);
      throw new CommerceError('preview_captured', 'Native standard payment challenge captured');
    };
    // Ignore every advertised alternative; only the operator-selected interface may receive requests.
    const selected = AgentCard.fromJSON({ ...(AgentCard.toJSON(card) as Record<string, unknown>), supportedInterfaces: [{ url: peer.endpoint, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }] });
    const client = await new ClientFactory({ transports: [new JsonRpcTransportFactory({ fetchImpl: capture })] }).createFromAgentCard(selected);
    try { await client.sendMessage(SendMessageRequest.fromJSON({ message: { messageId: input.messageId, role: 'ROLE_USER', parts: [{ data: input.input }] }, configuration: { returnImmediately: true } })); }
    catch (error) { if (!required) throw error; }
    if (!required || !body) throw new CommerceError('invalid_challenge', 'The approved endpoint did not return a native payment challenge');
    const requirements = standardRequirements(peer, required), policyDigest = standardPolicyDigest(peer);
    const quote: BuyerQuote = { quoteId: randomUUID(), messageId: input.messageId, payer: this.options.signer!.address.toLowerCase(), amount,
      currency: peer.currency, recipient: peer.recipient, expiresAt: new Date(Date.now() + requirements.maxTimeoutSeconds * 1000).toISOString(),
      serviceId: peer.id, serviceRevision: contract.revision, offerId: contract.offerId, inputDigest: digest(input.input), termsDigest: policyDigest, termsSource: 'local-policy' };
    return this.snapshot(this.options.store.insert({ protocol: 'x402', peerMode: 'standard-a2a', caller, peerId: peer.id, cardUrl: peer.cardUrl, endpoint: peer.endpoint,
      messageId: input.messageId, fingerprint, input: structuredClone(input.input), inputSchema: structuredClone(contract.inputSchema), body,
      quoteToken: randomBytes(32).toString('base64url'), quote, required, requirements,
      standardBinding: { policyDigest, bodyDigest: digest(body), challengeDigest: digest(required) } }));
  }
  private prepareFree(caller: string, input: BuyerPreviewInput, fingerprint: string, peer: Peer, endpoint: string, advertised: AdvertisedOffer): BuyerSnapshot {
    if (advertised.pricing?.kind !== 'free' || advertised.collection?.kind !== 'none' || advertised.payment !== null) throw new CommerceError('free_offer_required', 'This peer permits explicit free offers only');
    noExternalRefs(advertised.contract.inputSchema);
    const ajv = new Ajv2020({ strict: true }); addFormats(ajv);
    if (!ajv.compile(advertised.contract.inputSchema)(input.input)) throw new CommerceError('invalid_input', 'Input does not satisfy the advertised service schema');
    const quote: BuyerQuote = { quoteId: randomUUID(), messageId: input.messageId, payer: caller, amount: '0', currency: null, recipient: null, expiresAt: new Date(Date.now() + 600000).toISOString(), serviceId: advertised.serviceId, serviceRevision: advertised.serviceRevision, offerId: input.offerId, inputDigest: digest(input.input), termsDigest: advertised.termsDigest };
    const params = SendMessageRequest.fromJSON({ message: { messageId: input.messageId, role: 'ROLE_USER', parts: [{ data: input.input }] }, configuration: { returnImmediately: true } });
    const body = JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'SendMessage', params: SendMessageRequest.toJSON(params) });
    if (Buffer.byteLength(body) > 1024 * 1024) throw new CommerceError('request_too_large', 'Purchase input exceeds 1 MiB');
    return this.snapshot(this.options.store.insert({ protocol: 'free', caller, peerId: peer.id, cardUrl: peer.cardUrl, endpoint, messageId: input.messageId, fingerprint, input: structuredClone(input.input), inputSchema: structuredClone(advertised.contract.inputSchema), body, quoteToken: randomBytes(32).toString('base64url'), quote }));
  }
  private async replayFree(record: BuyerRecord): Promise<BuyerSnapshot> {
    try {
      const peer = this.assertCurrentPolicy(record, false);
      const response = await this.scopedFetch(peer, record.endpoint)(record.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: record.body });
      const raw = await response.json() as { result?: { task?: unknown } };
      if (response.ok && raw.result?.task) return this.snapshot(this.task(record, raw.result.task));
      return this.snapshot(this.options.store.update(record.id, { state: 'unknown', executionState: 'unknown', errorCode: response.status === 402 ? 'free_offer_payment_rejected' : 'original_purchase_pending' }));
    } catch { return this.snapshot(this.options.store.update(record.id, { state: 'unknown', executionState: 'unknown', errorCode: 'free_purchase_outcome_unknown' })); }
  }
  private prepareMpp(caller: string, input: BuyerPreviewInput, fingerprint: string, peer: Peer, endpoint: string, advertised: AdvertisedOffer, amount: string, body: string, challenge: Challenge.Challenge): BuyerSnapshot {
    const request = challenge.request, meta = challenge.meta ?? (challenge.opaque ? PaymentRequest.deserialize(challenge.opaque) as Record<string, string> : undefined);
    const method = request.methodDetails as { networkId?: string; paymentMethodTypes?: string[] } | undefined;
    const expiry = Date.parse(challenge.expires ?? '');
    assertMppDigest(challenge, body);
    if (challenge.method !== 'stripe' || challenge.intent !== 'charge' || challenge.header !== 'Payment-Authorization' || challenge.realm !== new URL(endpoint).host || atomic(amount) < 50n || atomic(amount) > 99999999n || request.amount !== amount || request.currency !== 'usd' || request.recipient !== peer.recipient || method?.networkId !== peer.recipient || method.paymentMethodTypes?.length !== 1 || method.paymentMethodTypes[0] !== 'card' || !meta || request.externalId !== meta.quoteId || meta.messageId !== input.messageId || meta.serviceId !== advertised.serviceId || meta.serviceRevision !== String(advertised.serviceRevision) || meta.offerId !== input.offerId || meta.inputDigest !== digest(input.input) || meta.termsDigest !== advertised.termsDigest || meta.amount !== amount || meta.currency !== 'usd' || meta.recipient !== peer.recipient || meta.expiresAt !== challenge.expires || !Number.isFinite(expiry) || expiry <= Date.now() || expiry > Date.now() + 3600000) throw new CommerceError('quote_mismatch', 'MPP challenge differs from the advertised offer or local wallet policy');
    const quote: BuyerQuote = { messageId: input.messageId, payer: this.options.mpp!.payer, amount, currency: 'usd', recipient: peer.recipient, expiresAt: challenge.expires!, serviceId: advertised.serviceId, serviceRevision: advertised.serviceRevision, offerId: input.offerId, inputDigest: digest(input.input), termsDigest: advertised.termsDigest, quoteId: meta.quoteId! };
    return this.snapshot(this.options.store.insert({ protocol: 'mpp', mppMode: this.options.mpp!.mode, mppPaymentMethod: this.options.mpp!.paymentMethod, mppChallenge: challenge, caller, peerId: peer.id, cardUrl: peer.cardUrl, endpoint, messageId: input.messageId, fingerprint, input: structuredClone(input.input), inputSchema: structuredClone(advertised.contract.inputSchema), body, quoteToken: randomBytes(32).toString('base64url'), quote }));
  }
  private async mppCredential(record: BuyerRecord, recover: boolean, beforeCreate?: () => void): Promise<BuyerRecord> {
    const options = this.options.mpp!;
    if (!record.mppChallenge || record.mppMode !== options.mode) throw new CommerceError('mpp_recovery_binding', 'Original MPP provider binding is missing or changed');
    const operationId = record.tokenOperationId ?? `mpp-token-${record.id}`;
    if (!recover) record = this.options.store.update(record.id, { tokenOperationId: operationId });
    const credential = await prepareMppCredential(record.mppChallenge!, record.mppPaymentMethod ?? options.paymentMethod, async parameters => {
      if (parameters.amount !== record.quote.amount || parameters.currency !== record.quote.currency || parameters.networkId !== record.quote.recipient || parameters.expiresAt !== Math.floor(Date.parse(record.quote.expiresAt) / 1000)) throw new CommerceError('mpp_token_binding', 'SPT request differs from frozen payment conditions');
      if (record.tokenRef) {
        const saved = this.options.vault!.get(record.tokenRef) as SavedMppToken;
        if (saved.protocol !== 'mpp-token' || saved.operationId !== operationId || saved.fingerprint !== record.fingerprint) throw new CommerceError('mpp_recovery_binding', 'Saved SPT differs from original operation');
        return saved.token;
      }
      const operation: MppTokenOperation = { operationId, idempotencyKey: operationId, purchaseId: record.id, quote: record.quote, mode: record.mppMode!, amount: parameters.amount, currency: parameters.currency, networkId: parameters.networkId!, expiresAt: parameters.expiresAt, paymentMethod: parameters.paymentMethod!, ...(parameters.metadata ? { metadata: parameters.metadata } : {}), challenge: record.mppChallenge! };
      let token: string | undefined;
      if (recover) {
        if (!record.tokenOperationId || !options.recoverToken) throw new CommerceError('mpp_token_recovery_required', 'Read the original SPT creation operation before retrying');
        token = await options.recoverToken(operation);
      } else {
        if (Date.now() >= Date.parse(record.quote.expiresAt)) throw new CommerceError('quote_expired', 'MPP quote expired before token creation');
        beforeCreate?.(); token = await options.createToken(operation);
      }
      if (typeof token !== 'string' || !/^spt_[A-Za-z0-9_]+$/.test(token)) throw new CommerceError('mpp_token_unknown', 'Original SPT creation is unresolved');
      const tokenRef = this.options.vault!.put({ protocol: 'mpp-token', token, fingerprint: record.fingerprint, operationId } satisfies SavedMppToken);
      record = this.options.store.update(record.id, { tokenRef });
      return token;
    });
    validateMppCredential(credential, record.mppChallenge!);
    const credentialRef = this.options.vault!.put({ protocol: 'mpp', credential, challenge: record.mppChallenge!, fingerprint: record.fingerprint, operationId } satisfies SavedMppAuthorization);
    return this.options.store.update(record.id, { credentialRef, state: 'submitted', paymentState: 'unknown' });
  }
  private async purchaseMpp(record: BuyerRecord): Promise<BuyerSnapshot> {
    let creationStarted = false;
    try {
      record = await this.mppCredential(record, false, () => { creationStarted = true; });
      return await this.replayMpp(record);
    } catch (error) {
      if (!creationStarted) return this.snapshot(this.options.store.rejectBeforeSigning(record.id, record.caller, error instanceof CommerceError ? error.code : 'pre_token_failure'));
      const current = this.record(record.caller, record.id);
      return this.snapshot(this.options.store.update(record.id, { state: 'unknown', paymentState: current.paymentState === 'confirmed' ? 'confirmed' : 'unknown', errorCode: error instanceof CommerceError ? error.code : 'mpp_outcome_unknown' }));
    }
  }
  private savedMpp(record: BuyerRecord): SavedMppAuthorization {
    if (!record.credentialRef) throw new CommerceError('mpp_token_recovery_required', 'Original MPP authorization must be recovered');
    const saved = this.options.vault!.get(record.credentialRef) as SavedMppAuthorization;
    if (saved.protocol !== 'mpp' || saved.operationId !== record.tokenOperationId || saved.fingerprint !== record.fingerprint || Challenge.serialize(saved.challenge) !== Challenge.serialize(record.mppChallenge!)) throw new CommerceError('mpp_recovery_binding', 'Saved native credential differs from original purchase');
    validateMppCredential(saved.credential, saved.challenge); return saved;
  }
  private async verifyMpp(record: BuyerRecord, receipt?: MppReceipt): Promise<BuyerRecord> {
    if (record.paymentState === 'confirmed' || !receipt) return record;
    if (receipt.method !== 'stripe' || receipt.status !== 'success' || !/^pi_[A-Za-z0-9]+$/.test(receipt.reference) || receipt.externalId !== record.quote.quoteId || receipt.amount !== record.quote.amount || receipt.currency !== record.quote.currency || receipt.merchant !== record.quote.recipient || receipt.livemode !== (record.mppMode === 'live')) throw new CommerceError('mpp_receipt_binding', 'MPP receipt does not match frozen terms and provider mode');
    const sanitized = publicMppReceipt(receipt);
    record = this.options.store.update(record.id, { receipt: sanitized });
    if (await this.options.mpp!.verifyReceipt(sanitized, { purchaseId: record.id, quote: record.quote, mode: record.mppMode!, operationId: record.tokenOperationId! })) return this.options.store.confirmed(record.id, sanitized);
    return record;
  }
  private async replayMpp(record: BuyerRecord): Promise<BuyerSnapshot> {
    const peer = this.assertCurrentPolicy(record, false), saved = this.savedMpp(record);
    const response = await this.scopedFetch(peer, record.endpoint)(record.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Payment-Authorization': saved.credential }, body: record.body });
    const header = response.headers.get('Payment-Receipt');
    if (header && header.length <= 65536) { try { record = await this.verifyMpp(record, Receipt.deserialize(header) as MppReceipt); } catch { /* receipt evidence remains unconfirmed */ } }
    const raw = await response.json() as { result?: { task?: unknown } };
    if (response.ok && raw.result?.task) record = this.task(record, raw.result.task);
    else record = this.options.store.update(record.id, { state: 'unknown', errorCode: 'original_purchase_pending' });
    return this.snapshot(record);
  }
  private async recoverMpp(record: BuyerRecord): Promise<BuyerSnapshot> {
    try {
      if (!record.credentialRef) record = await this.mppCredential(record, true);
      this.savedMpp(record);
      try { record = await this.verifyMpp(record, record.receipt as MppReceipt | undefined); } catch { /* explicit recovery can retry provider reads later */ }
      if (record.task?.id) return this.observe(record);
      return await this.replayMpp(record);
    } catch (error) { return this.snapshot(this.options.store.update(record.id, { state: 'unknown', errorCode: error instanceof CommerceError ? error.code : 'mpp_reconciliation_pending' })); }
  }
  /** Owner-only provider read. No replay, token creation, reservation or payment transition. */
  async authentication(caller: string, id: string): Promise<BuyerAuthentication> {
    const record = this.record(caller, id);
    if (record.protocol !== 'mpp') throw new CommerceError('mpp_authentication_unavailable', 'Original purchase does not use MPP');
    this.assertCurrentPolicy(record, false);
    if (!record.tokenOperationId || record.paymentState === 'confirmed') return { purchaseId: id, action: null };
    const provider = this.options.mpp;
    if (!provider?.getAuthentication) throw new CommerceError('mpp_authentication_unavailable', 'Configured provider does not support customer authentication');
    const action = await provider.getAuthentication({ purchaseId: record.id, quote: structuredClone(record.quote), mode: record.mppMode!, operationId: record.tokenOperationId });
    if (!action) return { purchaseId: id, action: null };
    if (action.type !== 'use_stripe_sdk' || typeof action.hashedValue !== 'string' || !action.hashedValue || action.hashedValue.length > 16384 ||
        typeof action.publishableKey !== 'string' || !new RegExp(`^pk_${record.mppMode}_[A-Za-z0-9]{1,256}$`).test(action.publishableKey)) {
      throw new CommerceError('stripe_spt_action_unsupported', 'Provider returned an unsupported or mismatched customer action');
    }
    return { purchaseId: id, action: { type: 'use_stripe_sdk', hashedValue: action.hashedValue, publishableKey: action.publishableKey } };
  }
  private assertCurrentPolicy(record: BuyerRecord, signing: boolean): Peer {
    const peer = this.peer(record.cardUrl);
    if (peer.id !== record.peerId || this.endpoint(peer) !== record.endpoint || peer.currency !== record.quote.currency || peer.recipient !== record.quote.recipient || (peer.protocol !== 'free' && atomic(record.quote.amount) > atomic(peer.maxPerPurchase)) || record.quote.payer !== (peer.protocol === 'free' ? record.caller : peer.protocol === 'mpp' ? this.options.mpp?.payer : this.options.signer?.address.toLowerCase()) || (record.protocol === 'mpp' && record.mppMode !== this.options.mpp?.mode)) throw new CommerceError('policy_changed', 'Original purchase no longer matches local wallet policy');
    if ((record.peerMode === 'standard-a2a') !== (peer.mode === 'standard-a2a')) throw new CommerceError('policy_changed', 'Original peer protocol profile changed');
    if (record.peerMode === 'standard-a2a') {
      if (peer.mode !== 'standard-a2a' || !record.standardBinding || record.standardBinding.policyDigest !== standardPolicyDigest(peer)) throw new CommerceError('policy_changed', 'Original local standard-peer contract or authentication changed');
      const quote = record.quote, contract = peer.localContract;
      if (quote.termsSource !== 'local-policy' || quote.termsDigest !== record.standardBinding.policyDigest || quote.inputDigest !== digest(record.input) || quote.messageId !== record.messageId || quote.amount !== contract.amount || quote.serviceId !== peer.id || quote.serviceRevision !== contract.revision || quote.offerId !== contract.offerId || digest(record.inputSchema) !== digest(contract.inputSchema)) throw new CommerceError('recovery_conflict', 'Local review quote no longer matches its frozen standard-peer contract and input');
      if (record.standardBinding.bodyDigest !== digest(record.body) || record.standardBinding.challengeDigest !== digest(record.required) || digest(standardRequirements(peer, record.required!)) !== digest(record.requirements)) throw new CommerceError('recovery_conflict', 'Original standard request or native challenge changed');
    }
    if (signing && peer.protocol !== 'free' && !this.policy.paymentsEnabled) throw new CommerceError('payments_disabled', 'Enable payments in local wallet policy before confirming');
    return peer;
  }
  async confirm(caller: string, input: BuyerConfirmInput): Promise<BuyerSnapshot> {
    const record = this.record(caller, input.previewId);
    const token = Buffer.from(input.quoteToken ?? ''), expected = Buffer.from(record.quoteToken);
    if (input.messageId !== record.messageId || token.length !== expected.length || !timingSafeEqual(token, expected)) throw new CommerceError('approval_mismatch', 'Confirm the original quote token and message ID');
    if (record.state !== 'previewed') return this.get(caller, record.id);
    this.assertCurrentPolicy(record, true);
    if (Date.now() >= Date.parse(record.quote.expiresAt)) throw new CommerceError('quote_expired', 'The reviewed quote has expired');
    return this.exclusive(record.id, () => this.purchase(caller, record.id));
  }
  private async exclusive(id: string, action: () => Promise<BuyerSnapshot>): Promise<BuyerSnapshot> {
    const prior = this.active.get(id); if (prior) return prior;
    const running = action(); this.active.set(id, running);
    try { return await running; } finally { this.active.delete(id); }
  }
  private async purchase(caller: string, id: string): Promise<BuyerSnapshot> {
    let record = this.record(caller, id); this.assertCurrentPolicy(record, true);
    if (record.protocol === 'free') { const started = this.options.store.beginFree(id, caller); return started.fresh ? this.replayFree(started.record) : this.snapshot(started.record); }
    const reserved = this.options.store.reserve(id, caller, this.policy); if (!reserved.fresh) return this.snapshot(reserved.record);
    record = reserved.record;
    if (record.protocol === 'mpp') return this.purchaseMpp(record);
    let signingStarted = false;
    try {
      const fromBlock = await this.options.checkpoint?.(record.requirements!);
      if (fromBlock !== undefined) record = this.options.store.update(id, { fromBlock });
      if (Date.now() >= Date.parse(record.quote.expiresAt)) throw new CommerceError('quote_expired', 'The reviewed quote expired before authorization');
      const client = new x402Client().setSpendControls(false).register(record.requirements!.network, new ExactEvmScheme({ address: this.options.signer!.address, signTypedData: async message => { signingStarted = true; return this.options.signer!.signTypedData(message); } }));
      const payload = await client.createPaymentPayload({ ...record.required!, accepts: [record.requirements!] });
      const auth = (payload.payload as { authorization?: { from: string; to: string; value: string; nonce: string } }).authorization;
      if (!auth || auth.from.toLowerCase() !== record.quote.payer || auth.to.toLowerCase() !== record.quote.recipient || auth.value !== record.quote.amount || !/^0x[0-9a-fA-F]{64}$/.test(auth.nonce) || digest(payload.accepted) !== digest(record.requirements!)) throw new CommerceError('signature_binding', 'Signer returned an authorization for different payment terms');
      const credentialRef = this.options.vault!.put({ payload, requirements: record.requirements!, fingerprint: record.fingerprint } satisfies SavedAuthorization);
      record = this.options.store.update(id, { credentialRef, nonce: auth.nonce, state: 'submitted', paymentState: 'unknown' });
      return await this.replay(record);
    } catch (error) {
      if (!signingStarted) return this.snapshot(this.options.store.rejectBeforeSigning(id, caller, error instanceof CommerceError ? error.code : 'pre_sign_failure'));
      return this.snapshot(this.options.store.update(id, { state: 'unknown', paymentState: this.record(caller, id).paymentState === 'confirmed' ? 'confirmed' : 'unknown', errorCode: error instanceof CommerceError ? error.code : 'purchase_outcome_unknown' }));
    }
  }
  private saved(record: BuyerRecord): SavedAuthorization {
    if (!record.credentialRef) throw new CommerceError('authorization_recovery_required', 'Interrupted signing has no durable authorization; do not create a replacement purchase');
    const saved = this.options.vault!.get(record.credentialRef) as SavedAuthorization;
    if (saved.fingerprint !== record.fingerprint || digest(saved.requirements) !== digest(record.requirements!)) throw new CommerceError('recovery_conflict', 'Original authorization does not match the frozen purchase');
    return saved;
  }
  private async verify(record: BuyerRecord, saved: SavedAuthorization, receipt?: SettleResponse): Promise<BuyerRecord> {
    if (record.paymentState === 'confirmed') return record;
    if (record.peerMode === 'standard-a2a' && receipt && (receipt.network !== saved.requirements.network || (receipt.payer && receipt.payer.toLowerCase() !== record.quote.payer))) throw new CommerceError('receipt_binding', 'Receipt differs from the original standard-peer chain or payer');
    if (receipt) record = this.options.store.update(record.id, { receipt });
    if (!receipt?.transaction && record.fromBlock && this.options.findOriginalReceipt) receipt = await this.options.findOriginalReceipt(saved.payload, saved.requirements, record.fromBlock);
    if (!receipt) return record;
    record = this.options.store.update(record.id, { receipt });
    if (receipt.success && await this.options.verifyReceipt!(receipt, saved.payload, saved.requirements)) return this.options.store.confirmed(record.id, receipt);
    return record;
  }
  private task(record: BuyerRecord, value: unknown): BuyerRecord {
    const task = Task.fromJSON(value as Record<string, unknown>);
    if (!task.id || !task.status || (record.task?.id && record.task.id !== task.id)) throw new CommerceError('task_binding', 'Peer returned a different or invalid durable Task');
    const done = task.status.state === TaskState.TASK_STATE_COMPLETED;
    const failed = [TaskState.TASK_STATE_FAILED, TaskState.TASK_STATE_REJECTED, TaskState.TASK_STATE_CANCELED].includes(task.status.state);
    const executionState = done ? 'completed' : failed ? 'failed' : task.metadata?.recoveryRequired || task.status.state === TaskState.TASK_STATE_UNSPECIFIED ? 'unknown' : task.status.state === TaskState.TASK_STATE_INPUT_REQUIRED ? 'input_required' : task.status.state === TaskState.TASK_STATE_AUTH_REQUIRED ? 'auth_required' : 'working';
    const serialized = Task.toJSON(task) as Record<string, unknown>;
    const continuations = record.continuations?.map(entry => entry.state !== 'resolved' && task.history.some(message => message.messageId === entry.messageId) ? { ...entry, state: 'resolved' as const } : entry);
    const unresolved = continuations?.some(entry => entry.state !== 'resolved');
    return this.options.store.update(record.id, { task: serialized, result: { artifacts: serialized.artifacts }, ...(continuations ? { continuations } : {}), executionState: unresolved ? 'unknown' : executionState, state: ['confirmed', 'not_required'].includes(record.paymentState) && !unresolved ? done ? 'completed' : failed ? 'failed' : 'submitted' : 'unknown', errorCode: unresolved ? 'continuation_outcome_unknown' : ['confirmed', 'not_required'].includes(record.paymentState) ? undefined : record.errorCode });
  }
  private async replay(record: BuyerRecord): Promise<BuyerSnapshot> {
    const peer = this.assertCurrentPolicy(record, false), saved = this.saved(record);
    const response = await this.scopedFetch(peer, record.endpoint)(record.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', 'PAYMENT-SIGNATURE': encodePaymentSignatureHeader(saved.payload) }, body: record.body });
    const receiptHeader = response.headers.get('PAYMENT-RESPONSE');
    let receipt: SettleResponse | undefined;
    if (receiptHeader && receiptHeader.length <= 65536) receipt = decodePaymentResponseHeader(receiptHeader);
    try { record = await this.verify(record, saved, receipt); } catch { /* retain the original receipt and reservation for reconciliation */ }
    const raw = await response.json() as { jsonrpc?: unknown; id?: unknown; result?: { task?: unknown; message?: unknown }; error?: unknown };
    if (record.peerMode === 'standard-a2a' && (raw.jsonrpc !== '2.0' || raw.id !== JSON.parse(record.body).id)) throw new CommerceError('rpc_response_binding', 'Peer response does not match the original standard JSON-RPC request');
    if (response.ok && raw.result?.task) record = this.task(record, raw.result.task);
    else if (record.peerMode === 'standard-a2a' && response.ok && raw.result?.message) {
      const message = Message.fromJSON(raw.result.message as Record<string, unknown>);
      if (!message.messageId || message.role !== Role.ROLE_AGENT || !message.parts.length) throw new CommerceError('message_binding', 'Peer returned an invalid A2A response message');
      record = this.options.store.update(record.id, { result: { message: Message.toJSON(message) }, executionState: 'completed', state: record.paymentState === 'confirmed' ? 'completed' : 'unknown' });
    }
    else record = this.options.store.update(record.id, { state: 'unknown', errorCode: 'original_purchase_pending' });
    return this.snapshot(record);
  }
  private client(record: BuyerRecord, fetchImpl?: typeof fetch) {
    const peer = this.assertCurrentPolicy(record, false);
    const card = AgentCard.fromJSON({ supportedInterfaces: [{ url: record.endpoint, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }], capabilities: {}, skills: [] });
    return new ClientFactory({ transports: [new JsonRpcTransportFactory({ fetchImpl: fetchImpl ?? this.scopedFetch(peer, record.endpoint) })] }).createFromAgentCard(card);
  }
  private async observe(record: BuyerRecord): Promise<BuyerSnapshot> {
    if (!record.task?.id) return this.snapshot(record);
    try {
      const task = await (await this.client(record)).getTask(GetTaskRequest.fromJSON({ id: String(record.task.id) }));
      return this.snapshot(this.task(record, Task.toJSON(task)));
    } catch { return this.snapshot(record); }
  }
  async continue(caller: string, id: string, input: { messageId: string; input: Input }): Promise<BuyerSnapshot> {
    const record = this.record(caller, id);
    if (record.peerMode === 'standard-a2a') throw new CommerceError('standard_continuation_unavailable', 'A standard peer has not promised included clarification; inspect its original Task without a new submission');
    if (typeof input.messageId !== 'string' || !input.messageId || input.messageId.length > 128 || input.messageId === record.messageId || !input.input || typeof input.input !== 'object' || Array.isArray(input.input)) throw new CommerceError('invalid_continuation', 'A distinct stable message ID and full object input are required');
    const running = this.active.get(id);
    if (running) { await running; return this.continue(caller, id, input); }
    return this.exclusive(id, async () => {
      let original = this.record(caller, id);
      this.options.store.assertMessageOwner(caller, input.messageId);
      if (this.options.store.find(caller, input.messageId)) throw new CommerceError('continuation_conflict', 'Clarification message ID is already used by a purchase');
      const previous = original.continuations ?? [];
      const duplicate = previous.find(entry => entry.messageId === input.messageId);
      if (duplicate) {
        if (digest(duplicate.input) !== digest(input.input)) throw new CommerceError('continuation_conflict', 'Continuation message ID already identifies different input');
        return this.snapshot(original);
      }
      if (previous.some(entry => entry.state !== 'resolved')) throw new CommerceError('continuation_unknown', 'Observe the original continuation before sending another round');
      if (!['confirmed', 'not_required'].includes(original.paymentState) || !original.task?.id || !['input_required', 'auth_required'].includes(original.executionState)) throw new CommerceError('continuation_unavailable', 'Only the original paid waiting Task accepts clarification');
      if (previous.length >= 10) throw new CommerceError('continuation_limit', 'This purchase has reached the clarification limit');
      const currentInput = previous.at(-1)?.input ?? original.input;
      const preserved = (before: unknown, after: unknown): boolean => {
        if (before && typeof before === 'object' && !Array.isArray(before)) return Boolean(after && typeof after === 'object' && !Array.isArray(after)) && Object.entries(before).every(([key, value]) => Object.hasOwn(after as object, key) && preserved(value, (after as Record<string, unknown>)[key]));
        return digest(before) === digest(after);
      };
      if (!preserved(currentInput, input.input)) throw new CommerceError('continuation_scope', 'Clarification cannot replace existing purchased input');
      const ajv = new Ajv2020({ strict: true }); addFormats(ajv);
      if (!ajv.compile(original.inputSchema)(input.input)) throw new CommerceError('invalid_input', 'Clarification must satisfy the original full input schema');
      const peer = this.assertCurrentPolicy(original, false);
      const entry = { messageId: input.messageId, input: structuredClone(input.input), state: 'pending' as const, beforeDigest: digest(original.task) };
      const scoped = this.scopedFetch(peer, original.endpoint);
      const capture: typeof fetch = async (request, init) => {
        const req = new Request(request, init); const body = await req.clone().text();
        if (Buffer.byteLength(body) > 1024 * 1024) throw new CommerceError('request_too_large', 'Clarification exceeds 1 MiB');
        original = this.options.store.update(id, { continuations: [...previous, { ...entry, body }], executionState: 'unknown' });
        return scoped(req);
      };
      try {
        const client = await this.client(original, capture);
        const task = await client.sendMessage(SendMessageRequest.fromJSON({ message: { messageId: input.messageId, taskId: String(original.task!.id), role: 'ROLE_USER', parts: [{ data: input.input }] }, configuration: { returnImmediately: true } }));
        if (!('status' in task)) throw new CommerceError('task_binding', 'Clarification returned no original Task');
        original = this.task(original, Task.toJSON(task));
        original = this.options.store.update(id, { continuations: (original.continuations ?? []).map(value => value.messageId === input.messageId ? { ...value, state: 'resolved' } : value) });
        return this.snapshot(this.task(original, Task.toJSON(task)));
      } catch {
        original = this.record(caller, id);
        return this.snapshot(this.options.store.update(id, { state: 'unknown', executionState: 'unknown', continuations: (original.continuations ?? []).map(value => value.messageId === input.messageId ? { ...value, state: 'unknown' } : value), errorCode: 'continuation_outcome_unknown' }));
      }
    });
  }
  async recover(caller: string, id: string): Promise<BuyerSnapshot> {
    const record = this.record(caller, id);
    if (record.state === 'previewed' || record.paymentState === 'rejected' || (['confirmed', 'not_required'].includes(record.paymentState) && ['completed', 'failed'].includes(record.executionState))) return this.snapshot(record);
    return this.exclusive(id, async () => {
      let original = this.record(caller, id); this.assertCurrentPolicy(original, false);
      if (original.protocol === 'mpp') return this.recoverMpp(original);
      if (original.protocol === 'free') return original.task?.id ? this.observe(original) : this.replayFree(original);
      try {
        const saved = this.saved(original);
        try { original = await this.verify(original, saved, original.receipt as SettleResponse | undefined); } catch { /* chain may remain unavailable */ }
        if (original.paymentState !== 'confirmed' && this.options.proveExpiredUnused) {
          let unused = false;
          try { unused = await this.options.proveExpiredUnused(saved.payload, saved.requirements); } catch { /* incomplete finalized chain evidence remains unknown */ }
          if (unused) return this.snapshot(this.options.store.rejectExpiredAuthorization(id, caller));
        }
        if (original.task?.id) {
          return this.observe(original);
        }
        if (original.peerMode === 'standard-a2a') {
          // A2A message IDs do not guarantee idempotent execution at an unrelated seller.
          // Keep the exact original authorization, but never POST it again after an ambiguous outcome.
          if (original.paymentState === 'confirmed' && original.executionState === 'completed' && original.result && typeof original.result === 'object' && 'message' in original.result) return this.snapshot(this.options.store.update(id, { state: 'completed', errorCode: undefined }));
          return this.snapshot(this.options.store.update(id, { state: 'unknown', executionState: 'unknown', errorCode: 'standard_task_recovery_required' }));
        }
        return await this.replay(original);
      } catch (error) { return this.snapshot(this.options.store.update(id, { state: 'unknown', errorCode: error instanceof CommerceError ? error.code : 'reconciliation_pending' })); }
    });
  }
}
