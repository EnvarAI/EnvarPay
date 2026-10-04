import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsImport from 'ajv-formats';
import canonicalizeImport from 'canonicalize';
import { CommerceError, type BuyerPolicy, type CommerceConfig, type PaymentProfile } from './types.js';

const canonicalize = canonicalizeImport as unknown as (data: unknown) => string | undefined;
const addFormats = addFormatsImport as unknown as (ajv: Ajv2020) => void;
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const schema = (name: string) => JSON.parse(readFileSync(new URL(`../../schemas/${name}`, import.meta.url), 'utf8'));
const sellerValidator = ajv.compile(schema('envarpay.config.schema.json'));
const buyerValidator = ajv.compile(schema('buyer-policy.schema.json'));
const USDC: Record<string, string> = {
  'eip155:84532': '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
  'eip155:8453': '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
};

export function atomic(value: string): bigint {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,77}$/.test(value)) throw new CommerceError('invalid_amount', 'Use a positive integer string in smallest currency units');
  const n = BigInt(value);
  if (n >= 2n ** 256n) throw new CommerceError('invalid_amount', 'Amount exceeds supported integer range');
  return n;
}

function noExternalRefs(value: unknown): void {
  if (Array.isArray(value)) { value.forEach(noExternalRefs); return; }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (['$ref', '$dynamicRef'].includes(key) && (typeof child !== 'string' || !child.startsWith('#'))) throw new CommerceError('external_schema_ref', 'Input schemas must contain only local references');
    noExternalRefs(child);
  }
}

export function validateUrl(value: string, allowPrivate = false): URL {
  const url = new URL(value);
  if (!['https:', ...(allowPrivate ? ['http:'] : [])].includes(url.protocol) || !url.hostname || url.username || url.password || url.hash) throw new CommerceError('invalid_url', 'Use an HTTP(S) URL without embedded credentials or fragment');
  return url;
}

export function currencyOf(profile: PaymentProfile): string {
  return profile.adapter === 'x402' ? `${profile.network}/erc20:${profile.asset.toLowerCase()}` : profile.currency;
}

function assertJson(value: unknown): void {
  if (typeof value === 'number' && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) throw new CommerceError('unsafe_json_number', 'Use strings for integers outside the safe JSON number range');
  if (value === undefined || typeof value === 'function' || typeof value === 'bigint' || typeof value === 'symbol') throw new CommerceError('invalid_json', 'Value must be JSON');
  if (value && typeof value === 'object') {
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new CommerceError('invalid_json', 'Only plain JSON objects are supported');
    for (const child of Object.values(value)) assertJson(child);
  }
}

export function digest(value: unknown): string {
  assertJson(value);
  const serialized = canonicalize(value);
  if (serialized === undefined) throw new CommerceError('invalid_json', 'Cannot canonicalize input');
  return createHash('sha256').update(serialized).digest('hex');
}

export function loadCommerceConfig(value: unknown): CommerceConfig {
  if (!sellerValidator(value)) throw new CommerceError('invalid_config', ajv.errorsText(sellerValidator.errors));
  const config = structuredClone(value) as CommerceConfig;
  const services = new Set<string>();
  for (const profile of Object.values(config.paymentProfiles)) {
    if (profile.adapter === 'x402') {
      if (USDC[profile.network] !== profile.asset.toLowerCase() || BigInt(profile.payTo) === 0n) throw new CommerceError('unsupported_payment_profile', 'MVP accepts official Base or Base Sepolia USDC and a nonzero receiving address');
      validateUrl(profile.facilitatorUrl);
    }
  }
  for (const service of config.services) {
    if (services.has(service.id)) throw new CommerceError('duplicate_service', 'Service IDs must be unique');
    services.add(service.id);
    validateUrl(service.execution.cardUrl, true);
    noExternalRefs(service.contract.inputSchema);
    const inputAjv = new Ajv2020({ strict: true });
    addFormats(inputAjv);
    inputAjv.compile(service.contract.inputSchema);
    const offers = new Set<string>();
    for (const offer of service.offers) {
      if (offers.has(offer.id)) throw new CommerceError('duplicate_offer', 'Offer IDs must be unique within a service');
      offers.add(offer.id);
      if (offer.pricing.kind === 'free') continue;
      const profile = config.paymentProfiles[offer.paymentProfile!];
      if (!profile) throw new CommerceError('missing_payment_profile', 'Offer refers to an unknown payment profile');
      let low: bigint, high: bigint;
      if (offer.pricing.kind === 'fixed') low = high = atomic(offer.pricing.amount);
      else {
        const q = offer.pricing.quantity;
        if (q.min > q.max) throw new CommerceError('invalid_quantity', 'Quantity bounds are reversed');
        let node: Record<string, unknown> = service.contract.inputSchema;
        for (const part of q.pointer.slice(1).split('/')) {
          const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
          const props = node.properties as Record<string, Record<string, unknown>> | undefined;
          node = props && Object.hasOwn(props, key) ? props[key]! : {};
        }
        if (node.type !== 'array' || q.min < Number(node.minItems ?? 0) || q.max > Number(node.maxItems ?? 10000)) throw new CommerceError('invalid_quantity', 'Quantity must reference a bounded declared array');
        low = atomic(offer.pricing.unitAmount) * BigInt(q.min);
        high = atomic(offer.pricing.unitAmount) * BigInt(q.max);
      }
      if (high >= 2n ** 256n) throw new CommerceError('invalid_amount', 'Maximum total exceeds supported integer range');
      if (profile.adapter === 'mpp' && low < 50n) throw new CommerceError('card_minimum', 'USD card orders must be at least 50 cents');
    }
  }
  return config;
}

export function loadBuyerPolicy(value: unknown): BuyerPolicy {
  if (!buyerValidator(value)) throw new CommerceError('invalid_policy', ajv.errorsText(buyerValidator.errors));
  const policy = structuredClone(value) as BuyerPolicy;
  const normalizedCurrency = (currency: string) => {
    if (currency === 'usd') return currency;
    const match = /^(eip155:[1-9][0-9]*)\/erc20:(0x[0-9a-fA-F]{40})$/.exec(currency);
    if (!match || USDC[match[1]!] !== match[2]!.toLowerCase()) throw new CommerceError('unsupported_currency', 'Buyer budget must use USD or an official supported USDC asset');
    return `${match[1]}/erc20:${match[2]!.toLowerCase()}`;
  };
  const limits = new Map<string, bigint>();
  for (const b of policy.budgets) {
    b.currency = normalizedCurrency(b.currency);
    if (limits.has(b.currency)) throw new CommerceError('duplicate_budget', 'Only one budget per currency is allowed');
    limits.set(b.currency, atomic(b.maxTotal));
  }
  const ids = new Set<string>();
  for (const peer of policy.peers) {
    validateUrl(peer.cardUrl);
    if (peer.mode === 'standard-a2a') {
      const endpoint = validateUrl(peer.endpoint), card = validateUrl(peer.cardUrl);
      if (endpoint.origin !== card.origin || endpoint.search || endpoint.href !== peer.endpoint || card.href !== peer.cardUrl) throw new CommerceError('standard_peer_endpoint', 'Review an exact same-origin HTTPS A2A endpoint without query parameters');
      noExternalRefs(peer.localContract.inputSchema);
      if (JSON.stringify(peer.localContract.inputSchema).length > 512 * 1024) throw new CommerceError('standard_peer_schema', 'Local input schema exceeds 512 KiB');
      try { const inputAjv = new Ajv2020({ strict: true }); addFormats(inputAjv); inputAjv.compile(peer.localContract.inputSchema); } catch { throw new CommerceError('standard_peer_schema', 'Local input schema must be a valid supported JSON Schema'); }
      if (atomic(peer.localContract.amount) > atomic(peer.maxPerPurchase)) throw new CommerceError('purchase_limit', 'Locally reviewed standard-peer price exceeds the per-purchase limit');
    }
    if (ids.has(peer.id)) throw new CommerceError('duplicate_peer', 'Peer IDs must be unique');
    ids.add(peer.id);
    if (peer.protocol === 'free') continue;
    peer.currency = normalizedCurrency(peer.currency);
    if (peer.protocol === 'x402') {
      if (!/^0x[0-9a-fA-F]{40}$/.test(peer.recipient) || BigInt(peer.recipient) === 0n || peer.currency === 'usd') throw new CommerceError('invalid_recipient', 'x402 peers require a nonzero EVM recipient and USDC asset');
      peer.recipient = peer.recipient.toLowerCase();
    } else if (peer.currency !== 'usd' || !/^profile_[A-Za-z0-9]+$/.test(peer.recipient)) throw new CommerceError('invalid_recipient', 'MPP peers require USD and a verified Stripe merchant profile');
    const limit = limits.get(peer.currency);
    if (limit === undefined || atomic(peer.maxPerPurchase) > limit) throw new CommerceError('invalid_budget', 'Each peer needs a cumulative budget at least as large as its per-purchase limit');
  }
  return policy;
}
