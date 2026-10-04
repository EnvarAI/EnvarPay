import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadCommerceConfig, loadBuyerPolicy, buildQuote, assertQuoteRequest, digest, atomic, createOfferCard } from '../dist/commerce/index.js';
import { AgentCard, A2A_PROTOCOL_VERSION } from '@a2a-js/sdk';

const raw = () => JSON.parse(readFileSync(new URL('../examples/seller.json', import.meta.url), 'utf8'));
const policy = () => JSON.parse(readFileSync(new URL('../examples/buyer-policy.json', import.meta.url), 'utf8'));
const input = {topic:'Agent directory', competitors:['A','B','C']};
const args = () => ({serviceId:'research',offerId:'usdc-once',caller:'buyer-a',messageId:'msg-1',input,now:new Date('2026-10-04T00:00:00Z')});

test('standalone seller and buyer configs require no platform identity', () => {
  const config = loadCommerceConfig(raw());
  assert.equal(config.services.length, 3);
  assert.equal(loadBuyerPolicy(policy()).paymentsEnabled, false);
  assert.equal('platform' in config, false);
});
test('schema rejects unknown future payment mode and unknown fields', () => {
  const c=raw(); c.services[0].offers[0].pricing.kind='subscription'; assert.throws(()=>loadCommerceConfig(c));
  const d=raw(); d.services[0].offers[0].price='0.1'; assert.throws(()=>loadCommerceConfig(d));
});
test('configuration rejects duplicate service, missing profile and invalid quantity pointer', () => {
  const c=raw(); c.services.push(c.services[0]); assert.throws(()=>loadCommerceConfig(c));
  const d=raw(); d.services[0].offers[0].paymentProfile='missing'; assert.throws(()=>loadCommerceConfig(d));
  const e=raw(); e.services[2].offers[0].pricing.quantity.pointer='/missing'; assert.throws(()=>loadCommerceConfig(e));
});
test('configuration rejects unsafe amounts, zero payee and remote schema resolution', () => {
  for(const value of ['0','01','0.1','1e3',3]) assert.throws(()=>atomic(value));
  const c=raw(); c.paymentProfiles['base-usdc'].payTo='0x'+'0'.repeat(40); assert.throws(()=>loadCommerceConfig(c));
  const d=raw(); d.services[0].contract.inputSchema={$ref:'https://example.com/schema'}; assert.throws(()=>loadCommerceConfig(d));
});
test('card minimum and unresolved merchant prevent a chargeable quote', () => {
  const c=raw(); c.services[0].offers[1].pricing.amount='10'; assert.throws(()=>loadCommerceConfig(c));
  assert.throws(()=>buildQuote(loadCommerceConfig(raw()),{...args(),offerId:'card-once'}),/merchant/);
});
test('fixed quote binds caller, message, input, version and actual recipient', () => {
  const q=buildQuote(loadCommerceConfig(raw()),args());
  assert.equal(q.amount,'3000000'); assert.equal(q.serviceRevision,1); assert.equal(q.recipient,'0x'+'2'.repeat(40));
  assertQuoteRequest(q,'buyer-a','msg-1',input,new Date('2026-10-04T00:01:00Z'));
  assert.throws(()=>assertQuoteRequest(q,'buyer-b','msg-1',input,new Date('2026-10-04T00:01:00Z')));
  assert.throws(()=>assertQuoteRequest(q,'buyer-a','msg-2',input,new Date('2026-10-04T00:01:00Z')));
  assert.throws(()=>assertQuoteRequest(q,'buyer-a','msg-1',{...input,topic:'Different'},new Date('2026-10-04T00:01:00Z')));
});
test('expired quote cannot be accepted', () => {
  const q=buildQuote(loadCommerceConfig(raw()),args());
  assert.throws(()=>assertQuoteRequest(q,'buyer-a','msg-1',input,new Date('2026-10-04T00:10:00Z')),/new quote/);
});
test('quote snapshots survive subsequent seller changes', () => {
  const config=loadCommerceConfig(raw()); const q=buildQuote(config,args());
  config.paymentProfiles['base-usdc'].payTo='0x'+'3'.repeat(40); config.services[0].offers[0].pricing.amount='1';
  assert.equal(q.amount,'3000000');assert.equal(q.paymentProfile.payTo,'0x'+'2'.repeat(40));
  assert.throws(()=>q.paymentProfile.payTo='0x'+'4'.repeat(40));
});
test('quantity is computed from validated input, not a supplied price', () => {
  const config=loadCommerceConfig(raw());const request={...args(),serviceId:'translation',offerId:'per-document',input:{documents:['one','two']}};
  assert.equal(buildQuote(config,request).amount,'200000');
  assert.throws(()=>buildQuote(config,{...request,input:{documents:['one','two'],quantity:1}}));
  assert.throws(()=>buildQuote(config,{...request,input:{documents:Array(21).fill('one')}}));
});
test('free service keeps input validation and has no payment', () => {
  const q=buildQuote(loadCommerceConfig(raw()),{...args(),serviceId:'summary-preview',offerId:'free',input:{text:'hello'}});
  assert.equal(q.amount,'0');assert.equal(q.paymentProfile,null);
  assert.throws(()=>buildQuote(loadCommerceConfig(raw()),{...args(),serviceId:'summary-preview',offerId:'free',input:{text:'x'.repeat(501)}}));
});
test('canonical digest uses stable key ordering', () => {
  assert.equal(digest({z:1,a:2}),digest({a:2,z:1}));
  assert.notEqual(digest({a:[1,2]}),digest({a:[2,1]}));
  assert.throws(()=>digest({value:Infinity}));assert.throws(()=>digest({value:9007199254740992}));
});
test('buyer cumulative limits and unique peers are enforced', () => {
  const p=policy();p.peers[0].maxPerPurchase='20000000';assert.throws(()=>loadBuyerPolicy(p));
  const q=policy();q.peers.push(q.peers[0]);assert.throws(()=>loadBuyerPolicy(q));
});
test('official pinned A2A SDK produces v1 offer cards and keeps offers separate', () => {
  assert.equal(A2A_PROTOCOL_VERSION,'1.0');
  const config=loadCommerceConfig(raw());
  const a=AgentCard.toJSON(createOfferCard(config,'research','usdc-once','https://seller.example'));
  const b=AgentCard.toJSON(createOfferCard(config,'research','card-once','https://seller.example'));
  assert.equal(a.supportedInterfaces.length,1);
  assert.equal(a.supportedInterfaces[0].protocolVersion,'1.0');
  assert.notEqual(a.supportedInterfaces[0].url,b.supportedInterfaces[0].url);
  assert.equal(a.securitySchemes.bearer.httpAuthSecurityScheme.scheme,'bearer');
});
