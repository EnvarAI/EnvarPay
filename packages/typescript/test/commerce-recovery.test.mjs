import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Task,TaskState,ListTasksRequest} from '@a2a-js/sdk';
import {ServerCallContext} from '@a2a-js/sdk/server';
import {loadCommerceConfig,buildQuote} from '../dist/commerce/index.js';
import {CommerceStore,CommerceServer,bearerAuthenticator,nativeA2AExecutor} from '../dist/commerce/runtime.js';

const origin='http://127.0.0.1:19410',tokenA='a'.repeat(40),tokenB='b'.repeat(40);
const route='/services/summary-preview/v1/offers/free/a2a';
function config(){
 const c=JSON.parse(readFileSync(new URL('../examples/seller.json',import.meta.url),'utf8'));
 c.services=c.services.filter(s=>s.id==='summary-preview');
 Object.assign(c.services[0].contract.inputSchema.properties,{clarification:{type:'string',maxLength:100},a:{type:'string'},b:{type:'string'},c:{type:'string'},d:{type:'string'},e:{type:'string'},f:{type:'string'},g:{type:'string'},h:{type:'string'},i:{type:'string'},j:{type:'string'},k:{type:'string'}});
 return loadCommerceConfig(c);
}
const ctx=(caller='buyer-a')=>new ServerCallContext({user:{isAuthenticated:true,userName:caller},tenant:'summary-preview:1',requestedVersion:'1.0'});
const task=(state='TASK_STATE_INPUT_REQUIRED',extras={})=>Task.fromJSON({id:'remote-task',contextId:'remote-context',status:{state},...extras});
const initial={message:{messageId:'initial',role:'ROLE_USER',parts:[{data:{text:'original'}}]},configuration:{returnImmediately:true}};
const follow=(id,data,messageId='clarification-1',contextId)=>({message:{messageId,taskId:id,...(contextId?{contextId}:{}),role:'ROLE_USER',parts:[{data}]},configuration:{returnImmediately:true}});
async function rpc(server,method,params,token=tokenA,headers={}){
 const response=await server.handle(new Request(origin+route,{method:'POST',headers:{Authorization:'Bearer '+token,'A2A-Version':'1.0','Content-Type':'application/json',...headers},body:JSON.stringify({jsonrpc:'2.0',id:'rpc',method,params})}));
 return {status:response.status,value:await response.json()};
}
async function idle(server){while(server.isRunning)await new Promise(r=>setTimeout(r,2));}
async function stop(server,store){server.stop();await idle(server);store.close();}
function serverFor(store,execute,options={}){return new CommerceServer({config:config(),origin,store,authenticate:bearerAuthenticator({[tokenA]:'buyer-a',[tokenB]:'buyer-b'}),execute,...options});}

for(const state of ['TASK_STATE_INPUT_REQUIRED','TASK_STATE_AUTH_REQUIRED'])test(`upstream ${state} remains waiting, not unknown`,async()=>{
 const store=new CommerceStore(':memory:');const server=serverFor(store,async function*(){yield task(state);});
 try{const sent=await rpc(server,'SendMessage',initial);const id=sent.value.result.task.id;await idle(server);
 const got=await rpc(server,'GetTask',{id});assert.equal(got.value.result.status.state,state);assert.equal(got.value.result.metadata?.recoveryRequired,undefined);
 assert.equal(store.findOrder('buyer-a','summary-preview:1','initial').executionState,state==='TASK_STATE_INPUT_REQUIRED'?'input_required':'auth_required');
 }finally{await stop(server,store);}
});

test('clarification preserves original fields, tenant, owner and Task; duplicate cannot execute twice',async()=>{
 const store=new CommerceStore(':memory:');let calls=0;
 const execute=async function*(){yield task();};
 execute.continue=async function*(order,service,continuation,remote){calls++;assert.equal(remote.taskId,'remote-task');assert.equal(remote.contextId,'remote-context');assert.deepEqual(order.input,{text:'original'});assert.deepEqual(continuation.input,{text:'original',clarification:'more detail'});yield task('TASK_STATE_COMPLETED',{artifacts:[{artifactId:'answer',parts:[{text:'done'}]}]});};
 const server=serverFor(store,execute);
 try{
 const first=await rpc(server,'SendMessage',initial);const id=first.value.result.task.id;await idle(server);
 assert.ok((await rpc(server,'SendMessage',follow(id,{clarification:'x'}),tokenB)).value.error);
 assert.ok((await rpc(server,'SendMessage',follow(id,{text:'different'}))).value.error);
 assert.ok((await rpc(server,'SendMessage',follow(id,{unlisted:'new work'}))).value.error);
 assert.ok((await rpc(server,'SendMessage',follow(id,{clarification:9}))).value.error);
 assert.ok((await rpc(server,'SendMessage',follow(id,{clarification:'x'},'c','wrong-context'))).value.error);
 const sent=await rpc(server,'SendMessage',follow(id,{clarification:'more detail'}));assert.equal(sent.value.result.task.id,id);await idle(server);
 const replay=await rpc(server,'SendMessage',follow(id,{clarification:'more detail'}));assert.equal(replay.value.result.task.status.state,'TASK_STATE_COMPLETED');assert.equal(calls,1);
 assert.ok((await rpc(server,'SendMessage',follow(id,{clarification:'changed'}))).value.error);
 assert.ok((await rpc(server,'SendMessage',follow(id,{a:'new task'},'new-terminal-message'))).value.error);
 }finally{await stop(server,store);}
});

test('ten clarification rounds are bounded within the initial task',async()=>{
 const store=new CommerceStore(':memory:');let calls=0;const execute=async function*(){yield task();};
 execute.continue=async function*(){calls++;yield task();};const server=serverFor(store,execute);
 try{const id=(await rpc(server,'SendMessage',initial)).value.result.task.id;await idle(server);
 for(const key of ['a','b','c','d','e','f','g','h','i','j']){assert.ok((await rpc(server,'SendMessage',follow(id,{[key]:'detail'},'round-'+key))).value.result);await idle(server);}
 assert.ok((await rpc(server,'SendMessage',follow(id,{k:'eleventh'},'round-k'))).value.error);assert.equal(calls,10);
 }finally{await stop(server,store);}
});

test('paid clarification requires initial settlement and never invokes payment gate again',async()=>{
 const c=config();c.services[0].offers=[{id:'free',pricing:{kind:'fixed',amount:'1000'},collection:{kind:'upfront'},paymentProfile:'base-usdc'}];
 const store=new CommerceStore(':memory:');let executes=0,settlements=0,gateCalls=0;
 const execute=async function*(){executes++;yield task();};execute.continue=async function*(){executes++;yield task('TASK_STATE_COMPLETED');};
 const gate={handle:async(request,order)=>{gateCalls++;if(!request.headers.has('X-Test-Payment'))return {response:Response.json({fixture:true},{status:402})};const id=store.reservePayment(order.id,order.caller,'fixture-payment','fixture-vault-ref');store.recordSettlement(id,'confirmed',{fixture:true});settlements++;return {headers:{}};}};
 const server=serverFor(store,execute,{config:c,paymentGate:gate});
 try{
 assert.equal((await rpc(server,'SendMessage',initial)).status,402);await idle(server);assert.equal(executes,0);
 const quoted=store.findOrder('buyer-a','summary-preview:1','initial');assert.ok((await rpc(server,'SendMessage',follow(quoted.taskId,{clarification:'x'}))).value.error);assert.equal(settlements,0);
 const first=await rpc(server,'SendMessage',initial,tokenA,{'X-Test-Payment':'fixture'});assert.ok(first.value.result,JSON.stringify(first));await idle(server);
 assert.ok((await rpc(server,'SendMessage',follow(first.value.result.task.id,{clarification:'x'}))).value.result);await idle(server);
 assert.equal(executes,2);assert.equal(settlements,1);assert.equal(gateCalls,2);
 }finally{await stop(server,store);}
});

test('lost clarification is not resubmitted or replaced until original GetTask proves acknowledgment',async()=>{
 const store=new CommerceStore(':memory:');let continues=0,ack=false;const execute=async function*(){yield task();};
 execute.continue=async function*(){continues++;throw new Error('lost response');};
 execute.recover=async()=>task('TASK_STATE_INPUT_REQUIRED',{history:ack?[{messageId:'lost',role:'ROLE_USER',taskId:'remote-task',parts:[{data:{clarification:'x'}}]}]:[]});
 const server=serverFor(store,execute);
 try{
 const id=(await rpc(server,'SendMessage',initial)).value.result.task.id;await idle(server);
 await rpc(server,'SendMessage',follow(id,{clarification:'x'},'lost'));await idle(server);
 const recovered=await rpc(server,'GetTask',{id});assert.equal(recovered.value.result.status.state,'TASK_STATE_INPUT_REQUIRED');assert.equal(recovered.value.result.metadata.recoveryRequired,true);
 assert.ok((await rpc(server,'SendMessage',follow(id,{a:'new'},'new'))).value.error);
 await rpc(server,'SendMessage',follow(id,{clarification:'x'},'lost'));assert.equal(continues,1);
 ack=true;const observed=await rpc(server,'GetTask',{id});assert.equal(observed.value.result.metadata?.recoveryRequired,undefined);
 assert.ok((await rpc(server,'SendMessage',follow(id,{a:'new'},'new'))).value.result);await idle(server);assert.equal(continues,2);
 }finally{await stop(server,store);}
});

test('unknown execution survives restart and owner GetTask recovers the original task only',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'envar-recovery-')),path=join(dir,'ledger.sqlite3');let store,server,sends=0,reads=0;
 try{
 store=new CommerceStore(path);const execute=async function*(){sends++;yield task('TASK_STATE_WORKING');throw new Error('disconnected');};server=serverFor(store,execute);
 const id=(await rpc(server,'SendMessage',initial)).value.result.task.id;await idle(server);assert.equal(store.findOrder('buyer-a','summary-preview:1','initial').executionState,'unknown');await stop(server,store);
 store=new CommerceStore(path);const restored=async function*(){sends++;throw new Error('must never rerun');};restored.recover=async(order,service,remote)=>{reads++;assert.equal(remote.taskId,'remote-task');return task('TASK_STATE_COMPLETED',{artifacts:[{artifactId:'a',parts:[{text:'original delivery'}]}]});};server=serverFor(store,restored);
 assert.ok((await rpc(server,'GetTask',{id},tokenB)).value.error);assert.equal(reads,0);
 const recovered=await rpc(server,'GetTask',{id});assert.equal(recovered.value.result.id,id);assert.equal(recovered.value.result.status.state,'TASK_STATE_COMPLETED');assert.equal(sends,1);assert.equal(reads,1);
 }finally{if(server&&store)await stop(server,store);rmSync(dir,{recursive:true,force:true});}
});

test('official native recovery sends GetTask only and pins the original interface',async()=>{
 const c=config(),service=c.services[0];service.execution.cardUrl='http://runtime.local/card.json';
 const card={name:'runtime',description:'runtime',version:'1',capabilities:{},skills:[],defaultInputModes:['application/json'],defaultOutputModes:['text/plain'],supportedInterfaces:[{url:'http://runtime.local/a2a',protocolBinding:'JSONRPC',protocolVersion:'1.0'}]};
 const calls=[];const transport=async input=>{const request=new Request(input);if(request.method==='GET')return Response.json(card);const body=await request.json();calls.push(body);return Response.json({jsonrpc:'2.0',id:body.id,result:{id:'remote-task',contextId:'remote-context',status:{state:'TASK_STATE_INPUT_REQUIRED'}}});};
 const execute=nativeA2AExecutor({'summary-preview':'private-runtime-token'},transport);
 const remote={origin:service.execution.cardUrl,taskId:'remote-task',contextId:'remote-context',interfaceUrl:'http://runtime.local/a2a'};
 assert.equal((await execute.recover({},service,remote)).id,'remote-task');assert.deepEqual(calls.map(x=>x.method),['GetTask']);assert.equal(calls[0].params.id,'remote-task');
 card.supportedInterfaces[0].url='http://runtime.local/another-service';await assert.rejects(execute.recover({},service,remote),/interface changed/);assert.equal(calls.length,1);
});

test('v1 ledger migration preserves original payment and task records',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'envar-migration-')),path=join(dir,'ledger.sqlite3');let store;
 try{store=new CommerceStore(path);const c=config();c.services[0].offers=[{id:'free',pricing:{kind:'fixed',amount:'1000'},collection:{kind:'upfront'},paymentProfile:'base-usdc'}];store.registerCatalog(c);const q=buildQuote(c,{caller:'buyer-a',serviceId:'summary-preview',offerId:'free',messageId:'before-upgrade',input:{text:'original'}});const o=store.ensureQuote(q,{text:'original'});const attempt=store.reservePayment(o.id,'buyer-a','original-economic-proof','original-credential-ref');store.recordSettlement(attempt,'confirmed',{transaction:'fixture-original'});store.close();
 const db=new DatabaseSync(path);db.exec('UPDATE commerce_meta SET version=1');db.close();
 store=new CommerceStore(path);assert.equal(store.findOrder('buyer-a','summary-preview:1','before-upgrade').id,o.id);assert.equal((await store.load(o.taskId,ctx())).id,o.taskId);assert.equal(store.claimReady().id,o.id);assert.equal(store.paymentForOrder(o.id).credentialRef,'original-credential-ref');assert.equal(store.paymentForOrder(o.id).receipt.transaction,'fixture-original');
 }finally{store?.close();rmSync(dir,{recursive:true,force:true});}
});

test('task list applies owner, status and pagination in the store',async()=>{
 const store=new CommerceStore(':memory:');try{const c=config();
 for(let i=0;i<4;i++){const q=buildQuote(c,{caller:'buyer-a',serviceId:'summary-preview',offerId:'free',messageId:'list-'+i,input:{text:'original'}});const o=store.ensureQuote(q,{text:'original'});store.enqueueFree(o.id,'buyer-a');await store.save(Task.fromJSON({id:o.taskId,contextId:'context',status:{state:i%2?'TASK_STATE_INPUT_REQUIRED':'TASK_STATE_COMPLETED'},artifacts:[{artifactId:'a',parts:[{text:'private'}]}]}),ctx());}
 const page=await store.list(ListTasksRequest.fromJSON({pageSize:1,status:'TASK_STATE_INPUT_REQUIRED'}),ctx());assert.equal(page.totalSize,2);assert.equal(page.tasks.length,1);assert.deepEqual(page.tasks[0].artifacts,[]);assert.equal(page.nextPageToken,'1');
 const next=await store.list(ListTasksRequest.fromJSON({pageSize:1,status:TaskState.TASK_STATE_INPUT_REQUIRED,pageToken:'1'}),ctx());assert.equal(next.nextPageToken,'');assert.notEqual(next.tasks[0].id,page.tasks[0].id);assert.equal((await store.list(ListTasksRequest.fromJSON({}),ctx('buyer-b'))).totalSize,0);
 }finally{store.close();}
});

test('queued clarification survives restart, interrupted dispatch never requeues',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'envar-clarification-restart-')),path=join(dir,'ledger.sqlite3');let store;
 try{
 const c=config();store=new CommerceStore(path);store.registerCatalog(c);
 const q=buildQuote(c,{caller:'buyer-a',serviceId:'summary-preview',offerId:'free',messageId:'restart-initial',input:{text:'original'}});
 const order=store.ensureQuote(q,{text:'original'});store.enqueueFree(order.id,order.caller);store.claimReady();
 store.recordRemoteTask(order.id,c.services[0].execution.cardUrl,'remote-task','remote-context','http://runtime.local/a2a');
 await store.save(Task.fromJSON({id:order.taskId,contextId:'local-context',status:{state:'TASK_STATE_INPUT_REQUIRED'}}),ctx());
 const follow=store.enqueueContinuation(order.id,order.caller,'restart-clarification',{clarification:'detail'},{text:'original',clarification:'detail'});store.close();
 store=new CommerceStore(path);const claimed=store.claimContinuation();assert.equal(claimed.continuation.id,follow.id);assert.equal(claimed.continuation.input.clarification,'detail');store.close();
 store=new CommerceStore(path);assert.equal(store.recoverInterruptedDispatches(),1);assert.equal(store.claimContinuation(),undefined);assert.equal(store.continuationFor(order.id,'restart-clarification').state,'unknown');assert.equal(store.remoteTask(order.id,order.caller).taskId,'remote-task');assert.equal((await store.load(order.taskId,ctx())).metadata.recoveryRequired,true);
 }finally{store?.close();rmSync(dir,{recursive:true,force:true});}
});

test('MPP initial quote requires resolved merchant and injects it before payment gate',async()=>{
 const c=config();c.paymentProfiles.card={adapter:'mpp',method:'stripe',intent:'charge',currency:'usd',accountRef:'merchant'};
 c.services[0].offers=[{id:'free',pricing:{kind:'fixed',amount:'1000'},collection:{kind:'upfront'},paymentProfile:'card'}];
 for(const ready of [false,true]){
  const store=new CommerceStore(':memory:');let gates=0;
  const gate={handle:async(_request,order)=>{gates++;assert.equal(order.quote.recipient,'profile_verified');return {response:Response.json({fixture:true},{status:402})};}};
  const server=serverFor(store,async function*(){throw new Error('unpaid must not execute');},{config:c,paymentGate:gate,...(ready?{stripeRecipientFor:ref=>ref==='merchant'?'profile_verified':undefined}:{})});
  try{const result=await rpc(server,'SendMessage',initial);if(ready){assert.equal(result.status,402);assert.equal(gates,1);}else{assert.equal(result.value.error.data.code,'merchant_not_ready');assert.equal(gates,0);}}
  finally{await stop(server,store);}
 }
});
