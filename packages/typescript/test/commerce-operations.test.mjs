import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,chmodSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Task} from '@a2a-js/sdk';
import {spawnSync} from 'node:child_process';
import {BuyerStore} from '../dist/commerce/buyer-store.js';
import {CommerceStore,CommerceServer,bearerAuthenticator} from '../dist/commerce/runtime.js';
import {loadCommerceConfig,buildQuote} from '../dist/commerce/index.js';
import {inspectLedger} from '../dist/commerce/operations.js';
const config=()=>loadCommerceConfig(JSON.parse(readFileSync(new URL('../examples/seller.json',import.meta.url),'utf8')));
const tick=()=>new Promise(r=>setTimeout(r,5));

test('readiness detects fatal worker/store failure while liveness stays distinct',async()=>{
 const store=new CommerceStore(':memory:');
 store.claimReady=()=>{throw new Error('private database detail')};
 const server=new CommerceServer({store,config:config(),origin:'http://127.0.0.1:19410',authenticate:bearerAuthenticator({['t'.repeat(40)]:'a'}),execute:async function*(){}});
 while(server.isRunning)await tick();
 const ready=await server.handle(new Request('http://127.0.0.1:19410/readyz'));
 assert.equal(ready.status,503);assert.deepEqual(await ready.json(),{status:'unavailable'});
 assert.equal((await server.handle(new Request('http://127.0.0.1:19410/healthz'))).status,200);
 const denied=await server.handle(new Request('http://127.0.0.1:19410/services/summary-preview/v1/offers/free/a2a',{method:'POST',headers:{Authorization:'Bearer '+'t'.repeat(40),'A2A-Version':'1.0','Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'1',method:'SendMessage',params:{message:{messageId:'m',role:'ROLE_USER',parts:[{data:{text:'x'}}]}}})}));
 assert.equal(denied.status,503);assert.equal(store.findOrder('a','summary-preview:1','m'),undefined);
 server.stop();store.close();
});

function ledgerContents(path) {
 const db=new DatabaseSync(path,{readOnly:true});
 try{return Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({name})=>[name,db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]));}
 finally{db.close();}
}

test('seller refund review selects paid terminal failures only and cannot change original payment or outbox',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'envar-refund-seller-')),path=join(dir,'seller.sqlite3'),store=new CommerceStore(path);
 const caller='secret owner',candidates=[];
 const make=async(messageId,payment,taskState)=>{
  const free=payment==='not_required',input=free?{text:'secret prompt'}:{topic:'secret prompt',competitors:['A']};
  const order=store.ensureQuote(buildQuote(config(),{serviceId:free?'summary-preview':'research',offerId:free?'free':'card-once',caller,messageId,input,stripeRecipient:'profile_test_owned'}),input);
  if(free)store.enqueueFree(order.id,caller);
  else{const attempt=store.reservePayment(order.id,caller,messageId,'secret credential');store.recordSettlement(attempt,payment,{reference:'pi_original',secret:'secret receipt'});}
  if(taskState&&['confirmed','not_required'].includes(payment))await store.save(Task.fromJSON({id:order.taskId,status:{state:taskState}}),{user:{isAuthenticated:true,userName:caller},tenant:order.serviceRevision});
  return order.id;
 };
 try{
  for(const state of ['TASK_STATE_FAILED','TASK_STATE_CANCELED','TASK_STATE_REJECTED'])candidates.push(await make(state,'confirmed',state));
  await make('completed','confirmed','TASK_STATE_COMPLETED');await make('working','confirmed','TASK_STATE_WORKING');
  await make('free-failed','not_required','TASK_STATE_FAILED');await make('rejected','rejected');await make('unknown','unknown');
  const before=ledgerContents(path),first=inspectLedger(path,0,2,'refund-review');
  assert.equal(first.role,'seller');assert.equal(first.view,'refund-review');assert.equal(first.total,8);assert.equal(first.refundReviewCount,3);assert.equal(first.attentionCount,1);
  assert.equal(first.items.length,2);assert.equal(first.hasMore,true);assert.equal(first.paymentPerformed,false);assert.equal(first.refundPerformed,false);
  const second=inspectLedger(path,first.nextCursor,2,'refund-review');assert.equal(second.hasMore,false);assert.equal(second.refundReviewCount,3);
  assert.deepEqual([...first.items,...second.items].map(x=>x.id),candidates);
  assert.ok([...first.items,...second.items].every(x=>x.reason==='confirmed_payment_failed_execution'&&x.paymentState==='confirmed'&&x.executionState==='failed'));
  const empty=inspectLedger(path,second.nextCursor,2,'refund-review');assert.deepEqual(empty.items,[]);assert.equal(empty.nextCursor,second.nextCursor);
  const attention=inspectLedger(path);assert.equal(attention.items.length,1);assert.equal(attention.items[0].paymentState,'unknown');assert.equal(attention.items[0].reason,undefined);
  assert.ok(!JSON.stringify([first,second,attention]).includes('secret'));assert.deepEqual(ledgerContents(path),before);
  const cli=spawnSync(process.execPath,[new URL('../dist/commerce/cli.js',import.meta.url).pathname,'inspect','--state',path,'--refund-review','--limit','2'],{encoding:'utf8'});
  assert.equal(cli.status,0,cli.stderr);assert.deepEqual(JSON.parse(cli.stdout),first);assert.deepEqual(ledgerContents(path),before);
  assert.throws(()=>inspectLedger(path,0,100,'refund'),{code:'inspection_view'});
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('buyer refund review retains spent and reserved budgets and excludes unpaid, unknown, free and successful work',()=>{
 const dir=mkdtempSync(join(tmpdir(),'envar-refund-buyer-')),path=join(dir,'buyer.sqlite3'),store=new BuyerStore(path),ids=[];
 const policy={policyVersion:1,paymentsEnabled:true,approval:'per_purchase',peers:[],budgets:[{currency:'usd',maxTotal:'1000',period:'cumulative'}]};
 const make=(messageId,payment,execution)=>{
  const record=store.insert({caller:'secret buyer',protocol:payment==='not_required'?'free':'mpp',peerId:'seller',cardUrl:'https://seller.example/card.json',endpoint:'https://seller.example/a2a',messageId,
   fingerprint:messageId,input:{secret:'secret input'},inputSchema:{},body:'secret body',quoteToken:'secret approval',
   quote:{messageId,payer:'secret payer',amount:payment==='not_required'?'0':'50',currency:payment==='not_required'?null:'usd',recipient:payment==='not_required'?null:'profile_test_owned',expiresAt:new Date(Date.now()+300000).toISOString(),serviceId:'service',serviceRevision:1,offerId:'offer',inputDigest:'digest',termsDigest:'terms',quoteId:messageId}});
  if(payment==='not_required')store.beginFree(record.id,'secret buyer');
  else{store.reserve(record.id,'secret buyer',policy);if(payment==='confirmed')store.confirmed(record.id,{method:'stripe',status:'success',reference:'pi_original',secret:'secret receipt'});else if(payment==='rejected')store.rejectBeforeSigning(record.id,'secret buyer','before_token');}
  store.update(record.id,{state:execution==='failed'?'failed':execution==='completed'?'completed':'unknown',paymentState:payment,executionState:execution,task:{id:'task-'+messageId},credentialRef:'secret vault ref'});
  return record.id;
 };
 try{
  ids.push(make('paid-failed-1','confirmed','failed'),make('paid-failed-2','confirmed','failed'));
  make('paid-completed','confirmed','completed');make('paid-unknown','confirmed','unknown');make('free-failed','not_required','failed');make('rejected-failed','rejected','failed');make('unknown-failed','unknown','failed');
  const before=ledgerContents(path),usage=store.usage('usd'),first=inspectLedger(path,0,1,'refund-review'),second=inspectLedger(path,first.nextCursor,1,'refund-review');
  assert.equal(first.role,'buyer');assert.equal(first.refundReviewCount,2);assert.equal(first.total,7);assert.equal(first.attentionCount,2);assert.equal(first.hasMore,true);assert.equal(second.hasMore,false);
  assert.deepEqual([first.items[0].id,second.items[0].id],ids);assert.ok([first,second].every(p=>p.items[0].reason==='confirmed_payment_failed_execution'));
  assert.deepEqual(store.usage('usd'),{spent:'200',reserved:'50'});assert.deepEqual(store.usage('usd'),usage);assert.deepEqual(ledgerContents(path),before);
  assert.ok(!JSON.stringify([first,second]).includes('secret'));assert.equal(inspectLedger(path).items.some(x=>ids.includes(x.id)),false);
  chmodSync(path,0o644);assert.throws(()=>inspectLedger(path,0,100,'refund-review'),{code:'private_file'});chmodSync(path,0o600);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
test('readiness reads actual ledger and never discloses database errors',async()=>{
 const store=new CommerceStore(':memory:');const server=new CommerceServer({store,config:config(),origin:'http://127.0.0.1:19410',authenticate:bearerAuthenticator({['t'.repeat(40)]:'a'}),execute:async function*(){}});
 while(server.isRunning)await tick();
 assert.equal((await server.handle(new Request('http://127.0.0.1:19410/readyz'))).status,200);
 store.close();const response=await server.handle(new Request('http://127.0.0.1:19410/readyz'));assert.equal(response.status,503);assert.deepEqual(await response.json(),{status:'unavailable'});server.stop();
});
test('owner-only read-only inspection returns paginated IDs/states without inputs or credentials',()=>{
 const dir=mkdtempSync(join(tmpdir(),'envar-inspect-')),path=join(dir,'ledger.sqlite3');let store;
 try{
  store=new CommerceStore(path);
  for(const messageId of ['a','b']){const input={topic:'secret prompt',competitors:['A']};const order=store.ensureQuote(buildQuote(config(),{serviceId:'research',offerId:'usdc-once',caller:'secret caller',messageId,input}),input);store.reservePayment(order.id,'secret caller',messageId,'secret credential');}
  const first=inspectLedger(path,0,1);assert.equal(first.role,'seller');assert.equal(first.attentionCount,2);assert.equal(first.items.length,1);assert.equal(first.hasMore,true);assert.equal(first.paymentPerformed,false);
  const second=inspectLedger(path,first.nextCursor,1);assert.notEqual(second.items[0].id,first.items[0].id);assert.equal(second.hasMore,false);assert.ok(!JSON.stringify([first,second]).includes('secret'));
  assert.throws(()=>inspectLedger(path,-1));chmodSync(path,0o644);assert.throws(()=>inspectLedger(path));chmodSync(path,0o600);symlinkSync(path,join(dir,'link'));assert.throws(()=>inspectLedger(join(dir,'link')));
  const db=new DatabaseSync(path,{readOnly:true});assert.equal(db.prepare('SELECT COUNT(*) AS n FROM commerce_payment_attempts').get().n,2);db.close();
 }finally{store?.close();rmSync(dir,{recursive:true,force:true});}
});
