import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Task} from '@a2a-js/sdk';
import {ServerCallContext} from '@a2a-js/sdk/server';
import {loadCommerceConfig,buildQuote} from '../dist/commerce/index.js';
import {CommerceStore} from '../dist/commerce/runtime.js';

const config=()=>loadCommerceConfig(JSON.parse(readFileSync(new URL('../examples/seller.json',import.meta.url),'utf8')));
const context=(who='buyer-a',tenant='summary-preview:1')=>new ServerCallContext({user:{isAuthenticated:true,userName:who},tenant,requestedVersion:'1.0'});
const input=(paid=false)=>paid?{topic:'x',competitors:['A']}:{text:'hello'};
const quote=(paid=false)=>buildQuote(config(),{serviceId:paid?'research':'summary-preview',offerId:paid?'usdc-once':'free',caller:'buyer-a',messageId:'m-001',input:paid?{topic:'x',competitors:['A']}:{text:'hello'}});

test('free order and Task survive restart; another buyer cannot read',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'envar-store-'));let store;
 try{store=new CommerceStore(join(dir,'ledger.sqlite3'));const order=store.ensureQuote(quote(),input());const task=store.enqueueFree(order.id,'buyer-a');assert.equal(store.enqueueFree(order.id,'buyer-a').id,task.id);assert.equal(await store.load(task.id,context('buyer-b')),undefined);store.close();store=new CommerceStore(join(dir,'ledger.sqlite3'));assert.equal((await store.load(task.id,context())).id,task.id);assert.equal(store.findOrder('buyer-a','summary-preview:1','m-001').id,order.id);}finally{store?.close();rmSync(dir,{recursive:true,force:true});}
});
test('same purchase ID cannot switch input or offer',()=>{const s=new CommerceStore(':memory:');try{const q=quote(true);s.ensureQuote(q,input(true));assert.throws(()=>s.ensureQuote({...q,inputDigest:'different'},input(true)));assert.throws(()=>s.ensureQuote({...q,offerId:'card-once'},input(true)));}finally{s.close();}});
test('paid order cannot enqueue before confirmed settlement',()=>{const s=new CommerceStore(':memory:');try{const o=s.ensureQuote(quote(true),input(true));assert.throws(()=>s.enqueueFree(o.id,'buyer-a'));assert.equal(s.claimReady(),undefined);const a=s.reservePayment(o.id,'buyer-a','chain-token-payer-nonce','private-ref');s.recordSettlement(a,'unknown',{});assert.equal(s.claimReady(),undefined);assert.throws(()=>s.reservePayment(o.id,'buyer-a','another-nonce','private-ref'));const t=s.recordSettlement(a,'confirmed',{tx:'fixture'});assert.equal(t.id,o.taskId);assert.equal(s.claimReady().id,o.id);assert.equal(s.claimReady(),undefined);assert.throws(()=>s.recordSettlement(a,'rejected',{}));}finally{s.close();}});
test('interrupted dispatch becomes unknown and is never blindly requeued',()=>{const s=new CommerceStore(':memory:');try{const o=s.ensureQuote(quote(),input());s.enqueueFree(o.id,'buyer-a');s.claimReady();assert.equal(s.recoverInterruptedDispatches(),1);assert.equal(s.claimReady(),undefined);assert.equal(s.getOrder(o.id,'buyer-a').executionState,'unknown');}finally{s.close();}});
test('original result persists and a different owner cannot overwrite it',async()=>{const s=new CommerceStore(':memory:');try{const o=s.ensureQuote(quote(),input());s.enqueueFree(o.id,'buyer-a');s.claimReady();const t=Task.fromJSON({id:o.taskId,contextId:'ctx',status:{state:'TASK_STATE_COMPLETED'},artifacts:[{artifactId:'a',parts:[{text:'result'}]}]});await s.save(t,context());assert.equal(s.getOrder(o.id,'buyer-a').executionState,'completed');assert.equal((await s.load(o.taskId,context())).artifacts[0].parts[0].content.value,'result');await assert.rejects(s.save(t,context('buyer-b')));assert.equal(s.claimReady(),undefined);}finally{s.close();}});
test('second payment cannot reuse an economic reference',()=>{const s=new CommerceStore(':memory:');try{const o=s.ensureQuote(quote(true),input(true));s.reservePayment(o.id,'buyer-a','same-proof','ref');const o2=s.ensureQuote({...quote(true),messageId:'m-002'},input(true));assert.throws(()=>s.reservePayment(o2.id,'buyer-a','same-proof','ref'));}finally{s.close();}});
test('service revision freezes runtime and payment settings',()=>{const s=new CommerceStore(':memory:');try{const c=config();s.registerCatalog(c);s.registerCatalog(c);c.paymentProfiles['base-usdc'].payTo='0x'+'3'.repeat(40);assert.throws(()=>s.registerCatalog(c));c.services.forEach(x=>x.revision++);s.registerCatalog(c);assert.equal(s.serviceRevision('research:1').revision,1);}finally{s.close();}});
test('a second process cannot own an active ledger',()=>{const dir=mkdtempSync(join(tmpdir(),'envar-lock-'));const p=join(dir,'ledger.sqlite3');let a;try{a=new CommerceStore(p);assert.throws(()=>new CommerceStore(p),/owner lock/);}finally{a?.close();rmSync(dir,{recursive:true,force:true});}});
