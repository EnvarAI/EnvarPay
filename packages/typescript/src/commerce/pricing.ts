import { randomUUID } from 'node:crypto';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsImport from 'ajv-formats';
import { atomic, currencyOf, digest, serviceTermsDigest } from './config.js';
import { CommerceError, type CommerceConfig, type Input, type PriceQuote } from './types.js';

const addFormats = addFormatsImport as unknown as (ajv: Ajv2020) => void;

export function buildQuote(config: CommerceConfig, args: {
  serviceId: string; offerId: string; caller: string; messageId: string;
  input: Input; now?: Date; ttlSeconds?: number; stripeRecipient?: string;
}): Readonly<PriceQuote> {
  if (!args.caller || !args.messageId || args.messageId.length > 128) throw new CommerceError('invalid_identity', 'Authenticated caller and stable message ID are required');
  const service = config.services.find(s => s.id === args.serviceId);
  const offer = service?.offers.find(o => o.id === args.offerId);
  if (!service || !offer) throw new CommerceError('offer_not_found', 'Service offer not found');
  const ajv = new Ajv2020({ strict: true }); addFormats(ajv);
  const validate = ajv.compile(service.contract.inputSchema);
  if (!validate(args.input)) throw new CommerceError('invalid_input', ajv.errorsText(validate.errors));
  let amount = 0n;
  if (offer.pricing.kind === 'fixed') amount = atomic(offer.pricing.amount);
  if (offer.pricing.kind === 'quantity') {
    let current: unknown = args.input;
    for (const part of offer.pricing.quantity.pointer.slice(1).split('/')) {
      const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
      current = current && typeof current === 'object' && Object.hasOwn(current, key) ? (current as Record<string, unknown>)[key] : undefined;
    }
    const q = offer.pricing.quantity;
    if (!Array.isArray(current) || current.length < q.min || current.length > q.max) throw new CommerceError('invalid_quantity', 'Input quantity outside the purchased range');
    amount = atomic(offer.pricing.unitAmount) * BigInt(current.length);
  }
  if (amount >= 2n ** 256n) throw new CommerceError('invalid_amount', 'Quoted amount is too large');
  const profile = offer.paymentProfile ? config.paymentProfiles[offer.paymentProfile]! : null;
  const recipient = profile?.adapter === 'x402' ? profile.payTo : profile ? args.stripeRecipient : null;
  if (profile?.adapter === 'mpp' && !recipient) throw new CommerceError('merchant_not_ready', 'Resolve and verify the Stripe merchant before quoting');
  const now = args.now ?? new Date(); const ttl = args.ttlSeconds ?? 600;
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > 3600 || !Number.isFinite(now.getTime())) throw new CommerceError('invalid_expiry', 'Quote lifetime must be 1–3600 seconds');
  const quote: PriceQuote = {
    quoteVersion: 1, quoteId: randomUUID(), caller: args.caller, serviceId: service.id,
    serviceRevision: service.revision, offerId: offer.id, messageId: args.messageId,
    inputDigest: digest(args.input), termsDigest: serviceTermsDigest(config.configVersion, service, offer, profile),
    issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + ttl * 1000).toISOString(),
    amount: amount.toString(), currency: profile ? currencyOf(profile) : null,
    recipient: recipient ?? null, paymentProfile: profile ? structuredClone(profile) : null,
  };
  if (quote.paymentProfile) Object.freeze(quote.paymentProfile);
  return Object.freeze(quote);
}

export function assertQuoteRequest(quote: Readonly<PriceQuote>, caller: string, messageId: string, input: Input, now = new Date()): void {
  if (quote.caller !== caller || quote.messageId !== messageId || quote.inputDigest !== digest(input)) throw new CommerceError('quote_mismatch', 'Request differs from the frozen quote');
  if (!Number.isFinite(now.getTime()) || !Number.isFinite(Date.parse(quote.expiresAt)) || now.getTime() >= Date.parse(quote.expiresAt)) throw new CommerceError('quote_expired', 'Review a new quote before payment');
}
