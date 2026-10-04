import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Challenge,Credential,Receipt} from 'mppx';
import {CommerceStore} from '../dist/commerce/store.js';
import {CredentialVault} from '../dist/commerce/vault.js';
import {MppGate} from '../dist/commerce/mpp.js';
import {buildQuote,loadCommerceConfig} from '../dist/commerce/index.js';

const url='http://127.0.0.1:19412/services/research/v1/offers/card-once/a2a';
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'envar-mpp-')),store=new CommerceStore(':memory:'),vault=new CredentialVault(dir,Buffer.alloc(32,7));
 const config=loadCommerceConfig(JSON.parse(readFileSync(new URL('../examples/seller.json',import.meta.url),'utf8')));
 const input={topic:'x',competitors:['A']},calls=[],intents=new Map();let mode='success';
 const provider={accountId:'acct_test',merchantProfile:'profile_test',mode:'test',assertReady:async()=>{},
  create:async(params,options)=>{calls.push({params,options});const status=mode==='action'?'requires_action':mode==='decline'?'requires_payment_method':'succeeded';
   const pi={id:'pi_test'+calls.length,status,amount:params.amount,amount_received:status==='succeeded'?params.amount:0,currency:params.currency,livemode:false,metadata:params.metadata};intents.set(pi.id,pi);
   if(mode==='lost')throw new Error('response lost after PSP accepted');return pi;},
  retrieve:async id=>intents.get(id),findOriginal:async id=>[...intents.values()].find(i=>i.metadata.envarpay_order===id)};
 const gate=new MppGate({store,vault,origin:new URL(url).origin,hmacSecret:'test-only-key-32-or-more-characters',providers:{'seller-stripe':provider}});
 const order=(messageId='m1')=>store.ensureQuote(buildQuote(config,{serviceId:'research',offerId:'card-once',caller:'buyer',messageId,input,stripeRecipient:'profile_test'}),input);
 const request=credential=>new Request(url,{method:'POST',headers:{Authorization:'Bearer identity-token',...(credential?{'Payment-Authorization':Credential.serialize(credential)}:{})},body:'{}'});
 const credential=c=>Credential.from({challenge:c,payload:{spt:'spt_test_original',externalId:c.request.externalId}});
 return {store,gate,order,request,credential,calls,intents,setMode:v=>{mode=v;},close:()=>{store.close();rmSync(dir,{recursive:true,force:true});}};
}

test('official MPP challenge keeps Bearer identity; confirmed PSP receipt enqueues exactly once',async()=>{
 const f=fixture();try{const order=f.order(),challengeResult=await f.gate.handle(f.request(),order);assert.equal(challengeResult.response.status,402);
  const challenge=Challenge.fromResponse(challengeResult.response);assert.equal(challenge.header,'Payment-Authorization');assert.equal(challenge.request.amount,'300');assert.equal(f.calls.length,0);
  const paid=await f.gate.handle(f.request(f.credential(challenge)),order);assert.ok(paid.headers,'paid response');const receipt=Receipt.deserialize(paid.headers['Payment-Receipt']);assert.equal(receipt.reference,'pi_test1');assert.equal(receipt.livemode,false);
  assert.equal(f.calls[0].options.idempotencyKey,`mpp_${challenge.id}_spt_test_original`);assert.equal(f.store.claimReady().id,order.id);assert.equal(f.store.claimReady(),undefined);
  const replay=await f.gate.handle(f.request(f.credential(challenge)),f.store.getOrder(order.id,'buyer'));assert.ok(replay.headers);assert.equal(f.calls.length,1);
 }finally{f.close();}
});
test('forged challenge, wrong buyer and reused SPT never start another payment',async()=>{
 const f=fixture();try{const order=f.order(),unpaid=await f.gate.handle(f.request(),order),challenge=Challenge.fromResponse(unpaid.response);
  const forged=f.credential({...challenge,request:{...challenge.request,amount:'1'}});await assert.rejects(f.gate.handle(f.request(forged),order));assert.equal(f.calls.length,0);
  await f.gate.handle(f.request(f.credential(challenge)),order);await assert.rejects(f.gate.recover(order.id,'different-buyer'));
  const next=f.order('m2'),second=Challenge.fromResponse((await f.gate.handle(f.request(),next)).response);
  await assert.rejects(f.gate.handle(f.request(f.credential(second)),next),/already bound/);assert.equal(f.calls.length,1);
 }finally{f.close();}
});
test('action required and decline keep work blocked; original read reconciliation never creates another intent',async()=>{
 for(const mode of ['action','decline']){const f=fixture();try{f.setMode(mode);const order=f.order(),challenge=Challenge.fromResponse((await f.gate.handle(f.request(),order)).response);
  const result=await f.gate.handle(f.request(f.credential(challenge)),order);assert.equal(result.response.status,503);assert.equal(f.store.claimReady(),undefined);
  assert.equal((await f.gate.recover(order.id,'buyer')).state,'unknown');assert.equal(f.calls.length,1);
  f.intents.get('pi_test1').status='canceled';assert.equal((await f.gate.recover(order.id,'buyer')).state,'rejected');assert.equal(f.calls.length,1);
 }finally{f.close();}}
});
test('lost create response finds the original intent by bound order metadata without another create',async()=>{
 const f=fixture();try{f.setMode('lost');const order=f.order(),challenge=Challenge.fromResponse((await f.gate.handle(f.request(),order)).response);
  const paid=await f.gate.handle(f.request(f.credential(challenge)),order);assert.ok(paid.headers);assert.equal(f.calls.length,1);assert.equal(f.store.getOrder(order.id,'buyer').paymentState,'confirmed');
 }finally{f.close();}
});
