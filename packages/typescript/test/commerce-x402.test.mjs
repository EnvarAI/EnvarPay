import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {decodePaymentRequiredHeader,encodePaymentSignatureHeader} from '@x402/core/http';
import {CommerceStore,CommerceServer,bearerAuthenticator} from '../dist/commerce/runtime.js';
import {loadCommerceConfig} from '../dist/commerce/index.js';
import {X402Gate} from '../dist/commerce/x402.js';
import {CredentialVault} from '../dist/commerce/vault.js';
import {x402Client} from '@x402/core/client';
import {ExactEvmScheme} from '@x402/evm/exact/client';
import {appendPaymentIdentifierToExtensions} from '@x402/extensions/payment-identifier';
import {Task} from '@a2a-js/sdk';

const payer='0x'+'1'.repeat(40),payee='0x'+'2'.repeat(40),token='a'.repeat(40);
const url='http://127.0.0.1:19411/services/research/v1/offers/usdc-once/a2a';
const rpc={jsonrpc:'2.0',id:1,method:'SendMessage',params:{message:{messageId:'buy-1',role:'ROLE_USER',parts:[{data:{topic:'x',competitors:['A']}}]},configuration:{returnImmediately:true}}};
const req=(payload,body=rpc)=>new Request(url,{method:'POST',headers:{Authorization:'Bearer '+token,'A2A-Version':'1.0','Content-Type':'application/json',...(payload?{'PAYMENT-SIGNATURE':encodePaymentSignatureHeader(payload)}:{})},body:JSON.stringify(body)});

function fixture({settle,verifyReceipt,checkpoint,findOriginalReceipt,proveExpiredUnused,mainnet=false}={}){
 const dir=mkdtempSync(join(tmpdir(),'envar-x402-'));const store=new CommerceStore(':memory:');const vault=new CredentialVault(dir,Buffer.alloc(32,7));
 const network=mainnet?'eip155:8453':'eip155:84532';
 const calls=[];const facilitator={getSupported:async()=>({kinds:[{x402Version:2,scheme:'exact',network}],extensions:[],signers:{}}),verify:async(payload)=>{assert.equal(payload.extensions?.['urn:envarpay:quote:1'],undefined,'local quote metadata must not become a required facilitator extension');calls.push('verify');return {isValid:true,payer};},settle:settle??(async()=>{calls.push('settle');return {success:true,payer,network,transaction:'0x'+'5'.repeat(64)};})};
 const gate=new X402Gate({store,vault,checkpoint,findOriginalReceipt,proveExpiredUnused,payerFor:()=>payer,facilitator:()=>facilitator,verifyReceipt:verifyReceipt??(async()=>{calls.push('receipt');return true;})});
 const config=loadCommerceConfig(JSON.parse(readFileSync(new URL('../examples/seller.json',import.meta.url),'utf8')));
 if(mainnet)Object.assign(config.paymentProfiles['base-usdc'],{network,asset:'0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'});
 const server=new CommerceServer({config,origin:new URL(url).origin,store,authenticate:bearerAuthenticator({[token]:'buyer'}),paymentGate:gate,execute:async function*(order){calls.push('execute');yield Task.fromJSON({id:'remote-'+order.id,status:{state:'TASK_STATE_COMPLETED'},artifacts:[{artifactId:'a',parts:[{text:'simulated-agent-result'}]}]});}});
 const close=async()=>{server.stop();while(server.isRunning)await new Promise(r=>setTimeout(r,5));store.close();rmSync(dir,{recursive:true,force:true});};
 return {server,store,vault,gate,calls,close};
}
const proof=required=>({x402Version:2,resource:required.resource,accepted:required.accepts[0],payload:{signature:'0x'+'6'.repeat(130),authorization:{from:payer,to:payee,value:required.accepts[0].amount,validAfter:'0',validBefore:'9999999999',nonce:'0x'+'7'.repeat(64)}}});

test('official x402 402 → receipt verified → one Task; replay never pays twice',async()=>{
 const f=fixture();try{
  const unpaid=await f.server.handle(req());assert.equal(unpaid.status,402);assert.deepEqual(f.calls,[]);
  const required=decodePaymentRequiredHeader(unpaid.headers.get('PAYMENT-REQUIRED'));assert.equal(required.accepts[0].amount,'3000000');assert.equal(required.accepts[0].extra.paymentFlow,'upfront');
  const paid=await f.server.handle(req(proof(required)));assert.equal(paid.status,200);assert.ok(paid.headers.get('PAYMENT-RESPONSE'));const body=await paid.json();assert.ok(body.result.task.id);
  while(f.server.isRunning)await new Promise(r=>setTimeout(r,5));assert.deepEqual(f.calls,['verify','settle','receipt','execute']);
  const replay=await f.server.handle(req(proof(required)));assert.equal((await replay.json()).result.task.id,body.result.task.id);assert.deepEqual(f.calls,['verify','settle','receipt','execute']);
 }finally{await f.close();}
});
test('changed input, wrong payer and amount never settle',async()=>{
 const f=fixture();try{
  const required=decodePaymentRequiredHeader((await f.server.handle(req())).headers.get('PAYMENT-REQUIRED'));
  const changed=structuredClone(rpc);changed.params.message.parts[0].data.topic='expensive';const rejected=await f.server.handle(req(proof(required),changed));assert.ok((await rejected.json()).error);
  const bad=proof(required);bad.payload.authorization.from='0x'+'3'.repeat(40);assert.ok((await(await f.server.handle(req(bad))).json()).error);
  const cheap=proof(required);cheap.accepted.amount='1';assert.ok((await(await f.server.handle(req(cheap))).json()).error);assert.deepEqual(f.calls,[]);
 }finally{await f.close();}
});
test('unsupported request configuration is rejected before a payment challenge',async()=>{
 const f=fixture();try{
  const malformed=structuredClone(rpc);malformed.params.configuration={taskPushNotificationConfig:{url:'https://example.com'}};
  assert.ok((await(await f.server.handle(req(undefined,malformed))).json()).error);
  malformed.params.configuration={returnImmediately:'false'};
  assert.ok((await(await f.server.handle(req(undefined,malformed))).json()).error);
  assert.deepEqual(f.calls,[]);
 }finally{await f.close();}
});
test('settlement timeout and unverified receipt preserve unknown with no execution',async()=>{
 for(const options of [{settle:async()=>{throw new Error('lost response');}},{verifyReceipt:async()=>false}]){
  const f=fixture(options);try{
   const required=decodePaymentRequiredHeader((await f.server.handle(req())).headers.get('PAYMENT-REQUIRED'));assert.equal((await f.server.handle(req(proof(required)))).status,503);
   const order=f.store.findOrder('buyer','research:1','buy-1');assert.equal(order.paymentState,'unknown');assert.equal(f.calls.includes('execute'),false);
   const attempt=f.store.paymentForOrder(order.id);assert.equal(f.vault.get(attempt.credentialRef).payload.payload.authorization.nonce,'0x'+'7'.repeat(64));
   assert.equal((await f.server.handle(req(proof(required)))).status,503);
  }finally{await f.close();}
 }
});
test('original known receipt can be reconciled without a new settlement or authorization',async()=>{
 let ready=false;const f=fixture({verifyReceipt:async()=>ready});try{
  const required=decodePaymentRequiredHeader((await f.server.handle(req())).headers.get('PAYMENT-REQUIRED'));
  assert.equal((await f.server.handle(req(proof(required)))).status,503);
  const order=f.store.findOrder('buyer','research:1','buy-1');ready=true;
  assert.equal((await f.gate.recover(order.id,'buyer')).state,'confirmed');
  assert.equal(f.calls.filter(x=>x==='settle').length,1);
  await assert.rejects(f.gate.recover(order.id,'other'));
  f.server.schedule();while(f.server.isRunning)await new Promise(r=>setTimeout(r,5));
  assert.equal(f.calls.filter(x=>x==='execute').length,1);
 }finally{await f.close();}
});

test('unmodified official x402 client echoes a compatible optional identifier declaration',async()=>{
 const f=fixture();try{
  const required=decodePaymentRequiredHeader((await f.server.handle(req())).headers.get('PAYMENT-REQUIRED'));
  const signed=[];const signer={address:payer,signTypedData:async data=>{signed.push(data);return '0x'+'6'.repeat(130);}};
  const client=new x402Client().setSpendControls({maxAmountPerPayment:'$3'}).register('eip155:84532',new ExactEvmScheme(signer));
  const payload=await client.createPaymentPayload(required);
  assert.equal(payload.resource.url,required.resource.url);assert.equal(signed.length,1);
  assert.equal((await f.server.handle(req(payload))).status,200);
 }finally{await f.close();}
});
test('identifier is bound once; native requirements stay frozen for repeated challenges',async()=>{
 const f=fixture();try{
  const first=decodePaymentRequiredHeader((await f.server.handle(req())).headers.get('PAYMENT-REQUIRED'));
  const second=decodePaymentRequiredHeader((await f.server.handle(req())).headers.get('PAYMENT-REQUIRED'));
  assert.deepEqual(first,second);
  const payload=proof(first);payload.extensions=appendPaymentIdentifierToExtensions(structuredClone(first.extensions),'pay_stable_identifier_12345');
  assert.equal((await f.server.handle(req(payload))).status,200);
  const other=structuredClone(rpc);other.params.message.messageId='buy-2';
  const next=decodePaymentRequiredHeader((await f.server.handle(req(undefined,other))).headers.get('PAYMENT-REQUIRED'));
  const reused=proof(next);reused.payload.authorization.nonce='0x'+'8'.repeat(64);reused.extensions=payload.extensions;
  const response=await(await f.server.handle(req(reused,other))).json();assert.equal(response.error.data.code,'identifier_reuse');
  assert.equal(f.calls.filter(x=>x==='settle').length,1);
  assert.equal(f.store.findOrder('buyer','research:1','buy-2').paymentState,'quoted');
 }finally{await f.close();}
});
test('lost transaction hash is recovered by original nonce checkpoint, without settling again',async()=>{
 let lookup=0;const f=fixture({checkpoint:async()=> '100',settle:async()=>{throw new Error('response lost');},findOriginalReceipt:async(payload,requirements,fromBlock)=>{
  lookup++;assert.equal(fromBlock,'100');assert.equal(payload.payload.authorization.nonce,'0x'+'7'.repeat(64));return {success:true,network:requirements.network,payer,transaction:'0x'+'5'.repeat(64)};
 }});try{
  const required=decodePaymentRequiredHeader((await f.server.handle(req())).headers.get('PAYMENT-REQUIRED'));
  assert.equal((await f.server.handle(req(proof(required)))).status,503);
  const order=f.store.findOrder('buyer','research:1','buy-1');assert.equal((await f.gate.recover(order.id,'buyer')).state,'confirmed');assert.equal(lookup,1);
  assert.equal((await f.gate.recover(order.id,'buyer')).state,'confirmed');assert.equal(lookup,1);
 }finally{await f.close();}
});
test('concurrent paid retries settle and dispatch at most once',async()=>{
 const f=fixture();try{
  const required=decodePaymentRequiredHeader((await f.server.handle(req())).headers.get('PAYMENT-REQUIRED'));
  await Promise.all(Array.from({length:8},()=>f.server.handle(req(proof(required)))));
  while(f.server.isRunning)await new Promise(r=>setTimeout(r,5));
  assert.equal(f.calls.filter(x=>x==='settle').length,1);assert.equal(f.calls.filter(x=>x==='execute').length,1);
 }finally{await f.close();}
});

test('mainnet USDC uses the official USD Coin signing domain',async()=>{
 const f=fixture({mainnet:true});try{
  const required=decodePaymentRequiredHeader((await f.server.handle(req())).headers.get('PAYMENT-REQUIRED'));
  assert.equal(required.accepts[0].network,'eip155:8453');assert.equal(required.accepts[0].extra.name,'USD Coin');
  const domains=[];const client=new x402Client().setSpendControls({maxAmountPerPayment:'$3'}).register('eip155:8453',new ExactEvmScheme({address:payer,signTypedData:async data=>{domains.push(data.domain);return '0x'+'6'.repeat(130);}}));
  await client.createPaymentPayload(required);assert.equal(domains[0].name,'USD Coin');assert.equal(domains[0].chainId,8453);
 }finally{await f.close();}
});


test('seller closes an unknown authorization only after expired-unused chain proof',async()=>{
 let proven=false,checks=0;const f=fixture({checkpoint:async()=> '100',settle:async()=>{throw new Error('broadcast response lost');},findOriginalReceipt:async()=>undefined,proveExpiredUnused:async()=>{checks++;return proven;}});
 try{
  const required=decodePaymentRequiredHeader((await f.server.handle(req())).headers.get('PAYMENT-REQUIRED'));
  await f.server.handle(req(proof(required)));const order=f.store.findOrder('buyer','research:1','buy-1');
  assert.equal((await f.gate.recover(order.id,'buyer')).state,'unknown');
  assert.equal(f.store.getOrder(order.id,'buyer').paymentState,'unknown');assert.equal(f.calls.includes('execute'),false);
  proven=true;const rejected=await f.server.handle(req(proof(required)));assert.equal(rejected.status,409);assert.equal((await rejected.json()).error,'authorization_expired_unused');
  assert.equal(f.store.getOrder(order.id,'buyer').paymentState,'rejected');assert.equal(f.calls.includes('execute'),false);
  assert.equal((await f.gate.recover(order.id,'buyer')).state,'rejected');assert.equal(checks,2);
 }finally{await f.close();}
});
