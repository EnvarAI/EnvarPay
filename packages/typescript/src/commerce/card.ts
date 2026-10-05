import { AgentCard } from '@a2a-js/sdk';
import type { CommerceConfig } from './types.js';
import { CommerceError } from './types.js';
import { validateUrl, serviceTermsDigest } from './config.js';

/** One deterministic offer route, serialized by the official A2A 1.0 codec. */
export function offerPath(serviceId: string, revision: number, offerId: string): string {
  return `/services/${encodeURIComponent(serviceId)}/v${revision}/offers/${encodeURIComponent(offerId)}`;
}

export function createOfferCard(config: CommerceConfig, serviceId: string, offerId: string, origin: string): AgentCard {
  const base = validateUrl(origin, true);
  if (base.search || base.pathname !== '/') throw new CommerceError('invalid_origin', 'Origin must not contain a path or query');
  const service = config.services.find(x=>x.id===serviceId);
  const offer = service?.offers.find(x=>x.id===offerId);
  if (!service || !offer) throw new CommerceError('offer_not_found', 'Service offer not found');
  const profile=offer.paymentProfile?config.paymentProfiles[offer.paymentProfile]!:null;
  const payment=profile?.adapter==='x402'?{adapter:'x402',network:profile.network,asset:profile.asset,payTo:profile.payTo}:profile?{adapter:'mpp',method:'stripe',intent:'charge',currency:profile.currency}:null;
  return AgentCard.fromJSON({
    name: service.name,
    description: `Deliverables: ${service.contract.deliverables.join(', ')}`,
    version: String(service.revision),
    supportedInterfaces: [{url: new URL(`${offerPath(service.id,service.revision,offer.id)}/a2a`,base).href,protocolBinding:'JSONRPC',protocolVersion:'1.0'}],
    capabilities: {streaming:false,pushNotifications:false,extensions:[{uri:'urn:envarpay:commerce:1',required:false,description:'Optional service offer metadata; standard A2A and payment transports remain independently usable',params:{serviceId:service.id,serviceRevision:service.revision,offerId:offer.id,pricing:offer.pricing,collection:offer.collection,contract:service.contract,payment,termsDigest:serviceTermsDigest(config.configVersion,service,offer,profile),...(config.configVersion===2&&service.execution.type==='skill'?{skillDigest:service.execution.skillDigest}:{})}}]},
    defaultInputModes:['application/json'], defaultOutputModes:['application/json','text/plain'],
    skills:[{id:service.id,name:service.name,description:`Purchase ${service.name}`,tags:[service.id]}],
    securitySchemes:{bearer:{httpAuthSecurityScheme:{scheme:'bearer'}}},
    securityRequirements:[{schemes:{bearer:{list:[]}}}],
  });
}
