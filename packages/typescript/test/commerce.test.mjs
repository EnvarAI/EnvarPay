import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadCommerceConfig, buildQuote, assertQuoteRequest, digest, atomic, createOfferCard } from '../dist/commerce/index.js';
import { AgentCard, A2A_PROTOCOL_VERSION } from '@a2a-js/sdk';

const raw = () => JSON.parse(readFileSync(new URL('../examples/seller.json', import.meta.url), 'utf8'));
const input = {topic:'Agent directory', competitors:['A','B','C']};
const args = () => ({serviceId:'research',offerId:'balance-once',caller:'buyer-a',messageId:'msg-1',input,now:new Date('2026-10-04T00:00:00Z')});

test('seller config keeps platform credentials outside public offer terms', () => {
  const config = loadCommerceConfig(raw());
  assert.equal(config.services.length, 3);
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
test('configuration rejects unsafe amounts, invalid balance accounts and remote schema resolution', () => {
  for(const value of ['0','01','0.1','1e3',3]) assert.throws(()=>atomic(value));
  const c=raw(); c.paymentProfiles['envar-usd'].accountRef='invalid account'; assert.throws(()=>loadCommerceConfig(c));
  const d=raw(); d.services[0].contract.inputSchema={$ref:'https://example.com/schema'}; assert.throws(()=>loadCommerceConfig(d));
});
test('only Envar balance profiles and signed micro-USD prices are accepted', () => {
  for (const profile of [{adapter:'x402'}, {adapter:'mpp'}]) {
    const c=raw(); c.paymentProfiles['envar-usd']=profile; assert.throws(()=>loadCommerceConfig(c));
  }
  const c=raw(); c.services[0].offers[0].pricing.amount=(2n**63n).toString(); assert.throws(()=>loadCommerceConfig(c), {code:'balance_amount'});
});
test('fixed quote binds caller, message, input, version and actual recipient', () => {
  const q=buildQuote(loadCommerceConfig(raw()),args());
  assert.equal(q.amount,'3000000'); assert.equal(q.serviceRevision,1); assert.equal(q.currency,'usd'); assert.equal(q.recipient,'envar');
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
  config.paymentProfiles['envar-usd'].accountRef='other-seller'; config.services[0].offers[0].pricing.amount='1';
  assert.equal(q.amount,'3000000');assert.equal(q.paymentProfile.accountRef,'envar');
  assert.throws(()=>q.paymentProfile.accountRef='other-seller');
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
test('official pinned A2A SDK produces v1 offer cards and keeps offers separate', () => {
  assert.equal(A2A_PROTOCOL_VERSION,'1.0');
  const config=loadCommerceConfig(raw());
  const a=AgentCard.toJSON(createOfferCard(config,'research','balance-once','https://seller.example'));
  const b=AgentCard.toJSON(createOfferCard(config,'summary-preview','free','https://seller.example'));
  assert.equal(a.supportedInterfaces.length,1);
  assert.equal(a.supportedInterfaces[0].protocolVersion,'1.0');
  assert.notEqual(a.supportedInterfaces[0].url,b.supportedInterfaces[0].url);
  assert.equal(a.securitySchemes.bearer.httpAuthSecurityScheme.scheme,'bearer');
});
