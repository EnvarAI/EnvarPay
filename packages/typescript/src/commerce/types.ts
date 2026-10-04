export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type Input = Record<string, JsonValue>;

export type Pricing =
  | { kind: 'free' }
  | { kind: 'fixed'; amount: string }
  | { kind: 'quantity'; unit: string; unitAmount: string;
      quantity: { pointer: string; measure: 'count'; min: number; max: number } };

export interface Offer {
  id: string;
  pricing: Pricing;
  collection: { kind: 'none' | 'upfront' };
  paymentProfile?: string;
}

export type PaymentProfile =
  | { adapter: 'x402'; scheme: 'exact'; network: string; asset: string; payTo: string; facilitatorUrl: string }
  | { adapter: 'mpp'; method: 'stripe'; intent: 'charge'; currency: 'usd'; accountRef: string };

export interface Service {
  id: string;
  name: string;
  revision: number;
  execution: { type: 'a2a'; cardUrl: string };
  contract: { inputSchema: Record<string, unknown>; deliverables: string[]; targetDurationSeconds: number; includedRevisions: 0 };
  offers: Offer[];
}

export interface CommerceConfig {
  configVersion: 1;
  agent: { id: string; name: string };
  paymentProfiles: Record<string, PaymentProfile>;
  services: Service[];
}

/** A separately reviewed transport profile; local terms are never advertised as seller promises. */
export interface StandardA2APeer {
  id: string; cardUrl: string; mode: 'standard-a2a'; protocol: 'x402';
  currency: string; recipient: string; maxPerPurchase: string;
  endpoint: string; authentication: 'none' | 'bearer';
  localContract: { revision: number; offerId: string; inputSchema: Record<string, unknown>; amount: string; paidOnly: true };
}

export interface BuyerPolicy {
  policyVersion: 1;
  paymentsEnabled: boolean;
  approval: 'per_purchase' | 'within_preapproved_limits';
  peers: (StandardA2APeer | { id: string; cardUrl: string; mode?: 'envarpay'; protocol: 'x402' | 'mpp'; currency: string; recipient: string; maxPerPurchase: string } | { id: string; cardUrl: string; mode?: 'envarpay'; protocol: 'free'; currency: null; recipient: null; maxPerPurchase: '0' })[];
  budgets: { currency: string; maxTotal: string; period: 'cumulative' }[];
}

export interface PriceQuote {
  quoteVersion: 1;
  quoteId: string;
  caller: string;
  serviceId: string;
  serviceRevision: number;
  offerId: string;
  messageId: string;
  inputDigest: string;
  termsDigest: string;
  issuedAt: string;
  expiresAt: string;
  amount: string;
  currency: string | null;
  recipient: string | null;
  paymentProfile: PaymentProfile | null;
}

export class CommerceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'CommerceError';
  }
}
