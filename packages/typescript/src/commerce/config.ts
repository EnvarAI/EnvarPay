import { readFileSync } from 'node:fs';
import { digest, validateUrl } from '@envarai/connect/shared';
export { digest, validateUrl } from '@envarai/connect/shared';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsImport from 'ajv-formats';
import { CommerceError, type CommerceConfig, type Offer, type PaymentProfile, type Service } from './types.js';

const addFormats = addFormatsImport as unknown as (ajv: Ajv2020) => void;
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const schema = (name: string) => JSON.parse(readFileSync(new URL(`../../schemas/${name}`, import.meta.url), 'utf8'));
const sellerValidator = ajv.compile(schema('envarpay.config.schema.json'));

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

export function currencyOf(profile: PaymentProfile): string {
  return profile.currency;
}

/** Keep legacy quotes unchanged; skill-bound quotes freeze the installed skill revision too. */
export function serviceTermsDigest(configVersion: 1 | 2, service: Service, offer: Offer, profile: PaymentProfile | null): string {
  const terms = {contract: service.contract, offer, profile};
  return digest(configVersion === 2 && service.execution.type === 'skill'
    ? {...terms, skill: {name: service.id, digest: service.execution.skillDigest}}
    : terms);
}

export function loadCommerceConfig(value: unknown): CommerceConfig {
  if (!sellerValidator(value)) throw new CommerceError('invalid_config', ajv.errorsText(sellerValidator.errors));
  const config = structuredClone(value) as CommerceConfig;
  const services = new Set<string>();
  for (const service of config.services) {
    if (services.has(service.id)) throw new CommerceError('duplicate_service', 'Service IDs must be unique');
    services.add(service.id);
    if (config.configVersion === 2 && service.execution.type === 'skill') {
      if (service.id !== service.name)
        throw new CommerceError('skill_name_mismatch', 'A version 2 service must use the exact installed skill name as its ID and name');
    } else if (config.configVersion === 1 && service.execution.type !== 'a2a') {
      throw new CommerceError('legacy_skill_mode', 'Skill-bound services require configVersion 2');
    }
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
      let high: bigint;
      if (offer.pricing.kind === 'fixed') high = atomic(offer.pricing.amount);
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
        high = atomic(offer.pricing.unitAmount) * BigInt(q.max);
      }
      if (high >= 2n ** 256n) throw new CommerceError('invalid_amount', 'Maximum total exceeds supported integer range');
      if (high > 2n ** 63n - 1n) throw new CommerceError('balance_amount', 'Envar balance prices must fit signed micro-USD');
    }
  }
  return config;
}
