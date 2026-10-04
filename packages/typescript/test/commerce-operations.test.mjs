import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,chmodSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
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
