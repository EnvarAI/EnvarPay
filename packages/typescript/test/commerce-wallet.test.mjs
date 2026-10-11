import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Task } from '@a2a-js/sdk';
import { Challenge } from 'mppx';
import { CommerceBuyer } from '../dist/commerce/buyer.js';
import { BuyerStore } from '../dist/commerce/buyer-store.js';
import { CommerceStore, CommerceServer } from '../dist/commerce/runtime.js';
import { CredentialVault } from '../dist/commerce/vault.js';
import { EnvarWalletClient, EnvarMerchantClient, walletChallengeWire } from '../dist/commerce/wallet-client.js';
import { EnvarWalletGate } from '../dist/commerce/wallet-gate.js';
import { digest, loadBuyerPolicy, loadCommerceConfig } from '../dist/commerce/config.js';

const issuer='https://wallet.example',origin='https://seller.example';
const merchant='11111111-1111-4111-8111-111111111111',subject='a'.repeat(64);
const buyerToken='b'.repeat(43),merchantToken='m'.repeat(43),identityToken='i'.repeat(43);
const endpoint=origin+'/services/echo/v1/offers/balance/a2a',cardUrl=endpoint.replace('/a2a','/agent-card.json');
const policy={policyVersion:1,paymentsEnabled:true,approval:'per_purchase',peers:[{id:'seller',cardUrl,protocol:'mpp',method:'envar',currency:'cny',recipient:merchant,issuer,environment:'sandbox',maxPerPurchase:'500'}],budgets:[{currency:'cny',maxTotal:'10000',period:'cumulative'}]};
const config={configVersion:1,agent:{id:'seller',name:'Seller'},paymentProfiles:{wallet:{adapter:'mpp',method:'envar',intent:'charge',currency:'cny',accountRef:'wallet',merchantId:merchant,issuer,environment:'sandbox',methodVersion:'1'}},services:[{id:'echo',name:'Echo',revision:1,execution:{type:'a2a',cardUrl:'https://upstream.example/agent-card.json'},contract:{inputSchema:{type:'object',additionalProperties:false,required:['prompt'],properties:{prompt:{type:'string',maxLength:100}}},deliverables:['Echo'],targetDurationSeconds:5,includedRevisions:0},offers:[{id:'balance',pricing:{kind:'fixed',amount:'500'},collection:{kind:'upfront'},paymentProfile:'wallet'}]}]};

// SDK fixture only: actual PostgreSQL and HTTP integration is run separately by Envar.
function fixture(options={}){
  const directory=mkdtempSync(join(tmpdir(),'envar-wallet-sdk-'));
  const sellerStore=new CommerceStore(':memory:'),sellerVault=new CredentialVault(join(directory,'seller-vault'),Buffer.alloc(32,8));
  let store=new BuyerStore(join(directory,'buyer.sqlite3'));
  const vault=new CredentialVault(join(directory,'buyer-vault'),Buffer.alloc(32,9));
  const challenges=new Map(),payments=new Map();
  const calls={reserve:0,capture:0,execute:0,complete:0,identities:[],paidBodies:[],paymentHeaders:[]};
  let loseReserve=options.loseReserve??false,losePaid=options.losePaid??false,losePreview=options.losePreview??false;
  const fail=(code,status)=>Response.json({error:{code}},{status});
  const output=payment=>{const result=structuredClone(payment);if(payment.state!=='reserved')delete result.paymentToken;delete result.key;return Response.json(result);};
  const walletFetch=async request=>{
    const url=new URL(request.url),path=url.pathname,body=request.method==='POST'?await request.json():{};
    const token=request.headers.get('Authorization');
    assert([`Bearer ${buyerToken}`,`Bearer ${merchantToken}`].includes(token));
    if(path.endsWith('/authorization'))return Response.json({principal:'buyer-principal',issuer,environment:'sandbox',currency:'cny',methodVersion:'1'});
    if(path.endsWith('/identity'))return Response.json({access_token:identityToken,token_type:'Bearer',expires_in:300,subject});
    if(path.endsWith('/introspect'))return Response.json(body.token===identityToken?{active:true,sub:subject,aud:endpoint,iss:issuer,scope:'a2a',exp:Math.floor(Date.now()/1000)+300}:{active:false});
    if(path.endsWith('/challenges')){assert.equal(token,`Bearer ${merchantToken}`);challenges.set(body.challenge.id,body.challenge);return Response.json({challenge:body.challenge});}
    if(path.endsWith('/reserve')){
      assert.equal(token,`Bearer ${buyerToken}`);
      if(options.denyReserve)return fail('grant_budget',403);
      let payment=[...payments.values()].find(p=>p.key===body.purchaseKey);
      if(!payment){
        calls.reserve++;const challenge=challenges.get(body.challenge.id);assert.deepEqual(challenge,body.challenge);
        payment={id:randomUUID(),key:body.purchaseKey,state:'reserved',amount:'500',currency:'cny',recipient:merchant,issuer,environment:'sandbox',challengeId:challenge.id,bindingDigest:digest(challenge),expiresAt:challenge.expires,refunded:'0',paymentToken:'t'.repeat(42)+calls.reserve};payments.set(payment.id,payment);
      }
      if(loseReserve){loseReserve=false;throw new Error('fixture reserve response lost');}
      return output(payment);
    }
    if(path.endsWith('/redeem')){
      assert.equal(token,`Bearer ${merchantToken}`);const payment=[...payments.values()].find(p=>p.paymentToken===body.paymentToken);
      assert(payment);const challenge=challenges.get(payment.challengeId);
      assert.deepEqual(body.binding,{challengeId:challenge.id,callerBinding:subject,endpoint,bodyDigest:challenge.digest});
      if(payment.state==='reserved'){
        calls.capture++;payment.state='captured';payment.receipt={method:'envar',status:'success',reference:payment.id,timestamp:new Date().toISOString(),amount:payment.amount,currency:'cny',recipient:merchant,issuer,environment:'sandbox',bindingDigest:payment.bindingDigest,externalId:challenge.request.externalId};
      }
      return output(payment);
    }
    if(path.endsWith('/lookup')){
      const payment=[...payments.values()].find(p=>url.searchParams.has('purchaseKey')?p.key===url.searchParams.get('purchaseKey'):p.challengeId===url.searchParams.get('challengeId'));
      return payment?output(payment):fail('not_found',404);
    }
    const id=path.split('/payments/')[1]?.split('/')[0],payment=payments.get(id);
    if(!payment)return fail('not_found',404);
    if(path.endsWith('/complete')){calls.complete++;return output(payment);}
    if(path.endsWith('/refund')){payment.state='refunded';payment.refunded=body.amount;return output(payment);}
    return output(payment);
  };
  let seller;
  const fetchImpl=async(input,init)=>{
    const request=new Request(input,init);
    if(request.url.startsWith(issuer))return walletFetch(request);
    if(request.headers.has('Payment-Authorization')){calls.identities.push(request.headers.get('Authorization'));calls.paidBodies.push(await request.clone().text());calls.paymentHeaders.push(request.headers.get('Payment-Authorization'));}
    const response=await seller.handle(request);
    if(losePreview&&response.status===402){losePreview=false;throw new Error('fixture unpaid response lost');}
    if(options.mutateChallenge&&response.status===402){const challenge=Challenge.fromResponse(response);options.mutateChallenge(challenge);return new Response('{}',{status:402,headers:{'WWW-Authenticate':Challenge.serialize(challenge)}});}
    if(losePaid&&request.headers.has('Payment-Authorization')){losePaid=false;throw new Error('fixture paid response lost');}
    return response;
  };
  const client=new EnvarWalletClient({issuer,environment:'sandbox',credential:buyerToken,principal:'buyer-principal',fetchImpl});
  const merchantClient=new EnvarMerchantClient({issuer,environment:'sandbox',credential:merchantToken,merchant,fetchImpl});
  const gate=new EnvarWalletGate({store:sellerStore,vault:sellerVault,origin,hmacSecret:'fixture-32-character-challenge-key-only',client:merchantClient});
  seller=new CommerceServer({config:loadCommerceConfig(config),origin,store:sellerStore,authenticate:merchantClient.authenticator(),paymentGate:gate,execute:async function*(order){calls.execute++;yield Task.fromJSON({id:'remote-'+order.id,status:{state:'TASK_STATE_COMPLETED'},artifacts:[{artifactId:'echo',parts:[{text:'fixture delivery'}]}]});}});
  const buyerOptions={policy,store,vault,wallet:client,peerTokens:{},fetchImpl};
  let buyer=new CommerceBuyer(buyerOptions);
  return {calls,payments,gate,seller,sellerStore,get store(){return store;},get buyer(){return buyer;},
    restart(){store.close();store=new BuyerStore(join(directory,'buyer.sqlite3'));buyer=new CommerceBuyer({...buyerOptions,store});},
    async finish(purchase){while(seller.isRunning)await new Promise(resolve=>setTimeout(resolve,1));return buyer.recover('owner',purchase.id);},
    async close(){await buyer.stop();seller.stop();while(seller.isRunning)await new Promise(resolve=>setTimeout(resolve,1));await gate.stop();store.close();sellerStore.close();rmSync(directory,{recursive:true,force:true});},
  };
}
const input=(messageId='wallet-one')=>({cardUrl,messageId,offerId:'balance',input:{prompt:'hello'}});
const confirm=(f,p)=>f.buyer.confirm('owner',{previewId:p.id,quoteToken:p.quoteToken,messageId:p.messageId});

test('MPP wallet purchase uses separate identity, original body and independently verified CNY charge',async()=>{
  const f=fixture();try{
    const preview=await f.buyer.preview('owner',input());assert.equal(preview.quote.currency,'cny');assert.equal(f.calls.reserve,0);
    const done=await f.finish(await confirm(f,preview));
    assert.equal(done.paymentState,'confirmed');assert.equal(done.executionState,'completed');assert.equal(done.paymentMethod,'envar');
    assert.equal(done.receipt.method,'envar');assert.equal(done.receipt.issuer,issuer);assert.equal(f.calls.reserve,1);assert.equal(f.calls.capture,1);assert.equal(f.calls.execute,1);
    assert.deepEqual(f.calls.identities,[`Bearer ${identityToken}`]);assert(!JSON.stringify(done).includes('paymentToken'));
    assert.deepEqual(f.store.usage('cny'),{reserved:'0',spent:'500'});
    await f.gate.flushCompletions();await f.gate.flushCompletions();assert.equal(f.calls.complete,1);
  }finally{await f.close();}
});

for(const fault of ['loseReserve','losePaid'])test(`${fault} recovers the original wallet operation after restart`,async()=>{
  const f=fixture({[fault]:true});try{
    const preview=await f.buyer.preview('owner',input()),unknown=await confirm(f,preview);assert.equal(unknown.state,'unknown');
    f.restart();const done=await f.finish(await f.buyer.recover('owner',unknown.id));
    assert.equal(done.paymentState,'confirmed');assert.equal(done.executionState,'completed');
    assert.equal(f.calls.reserve,1);assert.equal(f.calls.capture,1);assert.equal(f.calls.execute,1);
    if(f.calls.paidBodies.length>1){assert.equal(f.calls.paidBodies[0],f.calls.paidBodies[1]);assert.equal(f.calls.paymentHeaders[0],f.calls.paymentHeaders[1]);}
  }finally{await f.close();}
});

test('an unpaid preview lost before local persistence keeps identical request bytes',async()=>{
  const f=fixture({losePreview:true});try{
    await assert.rejects(f.buyer.preview('owner',input()));f.restart();
    const preview=await f.buyer.preview('owner',input());const done=await f.finish(await confirm(f,preview));
    assert.equal(done.executionState,'completed');assert.equal(f.calls.reserve,1);assert.equal(f.calls.capture,1);
  }finally{await f.close();}
});

test('known grant rejection releases only the local unused reservation',async()=>{
  const f=fixture({denyReserve:true});try{
    const result=await confirm(f,await f.buyer.preview('owner',input()));
    assert.equal(result.paymentState,'rejected');assert.equal(f.calls.capture,0);assert.equal(f.calls.execute,0);
    assert.deepEqual(f.store.usage('cny'),{reserved:'0',spent:'0'});
  }finally{await f.close();}
});

test('wallet issuer, amount, caller and payment header tampering are rejected before reserve',async()=>{
  for(const mutateChallenge of [c=>{c.request.amount='1';},c=>{c.request.methodDetails.issuer='https://foreign.example';},c=>{c.header='Authorization';},c=>{const meta=JSON.parse(Buffer.from(c.opaque,'base64url'));meta.callerBinding='b'.repeat(64);c.opaque=Buffer.from(JSON.stringify(meta)).toString('base64url');delete c.meta;}]){
    const f=fixture({mutateChallenge});try{await assert.rejects(f.buyer.preview('owner',input()));assert.equal(f.calls.reserve,0);assert.equal(f.calls.execute,0);}finally{await f.close();}
  }
});

test('refund blocks another execution from the original receipt',async()=>{
  const f=fixture();try{
    const preview=await f.buyer.preview('owner',input());await f.finish(await confirm(f,preview));
    const order=f.sellerStore.findOrder(subject,'echo:1',preview.messageId);
    await f.gate.refund(order.id,subject,'500','fixture refund','refund-once');
    const response=await f.seller.handle(new Request(endpoint,{method:'POST',headers:{Authorization:`Bearer ${identityToken}`,'Content-Type':'application/json','A2A-Version':'1.0','Payment-Authorization':f.calls.paymentHeaders[0]},body:f.calls.paidBodies[0]}));
    assert.equal((await response.json()).error.data.code,'wallet_refunded');assert.equal(f.calls.execute,1);
  }finally{await f.close();}
});

test('CNY requires the explicit Envar method and loopback HTTP remains sandbox-only',()=>{
  const invalid=structuredClone(policy);delete invalid.peers[0].method;assert.throws(()=>loadBuyerPolicy(invalid));
  const local=structuredClone(policy);local.peers[0].cardUrl='http://127.0.0.1:18082/agent-card.json';assert.doesNotThrow(()=>loadBuyerPolicy(local));local.peers[0].environment='live';assert.throws(()=>loadBuyerPolicy(local));
});
