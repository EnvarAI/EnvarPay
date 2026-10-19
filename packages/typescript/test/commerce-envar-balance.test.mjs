import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {loadCommerceConfig} from '../dist/commerce/config.js';
import {buildQuote} from '../dist/commerce/pricing.js';
import {CommerceStore} from '../dist/commerce/store.js';
import {CredentialVault} from '../dist/commerce/vault.js';
import {EnvarBalanceGate} from '../dist/commerce/envar-balance.js';

function fixture(){
  const config=JSON.parse(readFileSync(new URL('../examples/seller.json',import.meta.url),'utf8'));
  config.paymentProfiles={balance:{adapter:'envar_balance',currency:'usd',accountRef:'seller-main'}};
  config.services=[config.services[1]];
  config.services[0].offers=[{id:'balance',pricing:{kind:'fixed',amount:'100'},collection:{kind:'upfront'},paymentProfile:'balance'}];
  return loadCommerceConfig(config);
}
function receipt(order,platformOrderId){const q=order.quote;return {
  state:'captured',order_id:platformOrderId,economic_id:`ledger:${randomUUID()}`,
  amount:q.amount,currency:q.currency,recipient:q.recipient,quote_id:q.quoteId,
  message_id:q.messageId,task_id:order.taskId,service_id:q.serviceId,service_revision:q.serviceRevision,
  offer_id:q.offerId,input_digest:q.inputDigest,terms_digest:q.termsDigest,
};}

test('Envar balance requires a platform claim and dispatches once after exact captured receipt',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'envar-balance-gate-'));
  const store=new CommerceStore(':memory:'),vault=new CredentialVault(join(directory,'vault'),Buffer.alloc(32,4));
  try{
    const config=fixture();store.registerCatalog(config);
    const q=buildQuote(config,{serviceId:'summary-preview',offerId:'balance',caller:'envar-platform',messageId:randomUUID(),input:{text:'hello'}});
    assert.equal(q.currency,'usd');assert.equal(q.recipient,'seller-main');
    const order=store.ensureQuote(q,{text:'hello'}),platformOrderId=randomUUID(),claimToken='a'.repeat(40);
    let calls=0;const gate=new EnvarBalanceGate({store,vault,claim:async args=>{calls++;assert.equal(args.platformOrderId,platformOrderId);return receipt(order,platformOrderId);}});
    const challenged=await gate.handle(new Request('https://seller.example/a2a'),order);
    assert.equal(challenged.response.status,402);
    assert.equal((await challenged.response.json()).quote.amount,'100');
    const request=new Request('https://seller.example/a2a',{headers:{'Envar-Balance-Order':platformOrderId,'Envar-Balance-Claim':claimToken}});
    const paid=await gate.handle(request,order);
    assert.match(paid.headers['ENVAR-BALANCE-RECEIPT'],/^ledger:/);
    assert.equal(store.paymentForOrder(order.id).state,'confirmed');
    assert.equal(store.claimReady().id,order.id);
    await gate.handle(request,{...order,paymentState:'confirmed'});
    assert.equal(calls,1);
    assert.equal(store.claimReady(),undefined);
  }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});

test('an unknown platform response retries only the original claim and rejects mismatched terms',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'envar-balance-recover-'));
  const store=new CommerceStore(':memory:'),vault=new CredentialVault(join(directory,'vault'),Buffer.alloc(32,5));
  try{
    const config=fixture();store.registerCatalog(config);
    const q=buildQuote(config,{serviceId:'summary-preview',offerId:'balance',caller:'envar-platform',messageId:randomUUID(),input:{text:'hello'}});
    const order=store.ensureQuote(q,{text:'hello'}),platformOrderId=randomUUID();
    let calls=0;const gate=new EnvarBalanceGate({store,vault,claim:async()=>{calls++;if(calls===1)throw Error('lost response');return receipt(order,platformOrderId);}});
    const request=new Request('https://seller.example/a2a',{headers:{'Envar-Balance-Order':platformOrderId,'Envar-Balance-Claim':'b'.repeat(40)}});
    assert.equal((await gate.handle(request,order)).response.status,503);
    assert.equal(store.paymentForOrder(order.id).state,'unknown');
    const recovered=await gate.handle(new Request('https://seller.example/a2a'),{...order,paymentState:'unknown'});
    assert.match(recovered.headers['ENVAR-BALANCE-RECEIPT'],/^ledger:/);
    assert.equal(calls,2);
    assert.equal(store.paymentForOrder(order.id).state,'confirmed');

    const second=store.ensureQuote(buildQuote(config,{serviceId:'summary-preview',offerId:'balance',caller:'envar-platform',messageId:randomUUID(),input:{text:'again'}}),{text:'again'});
    const mismatch=new EnvarBalanceGate({store,vault,claim:async()=>({...receipt(second,randomUUID()),amount:'999'})});
    const wrong=await mismatch.handle(new Request('https://seller.example/a2a',{headers:{'Envar-Balance-Order':randomUUID(),'Envar-Balance-Claim':'c'.repeat(40)}}),second);
    assert.equal(wrong.response.status,503);
    assert.equal(store.paymentForOrder(second.id).state,'unknown');
  }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});
