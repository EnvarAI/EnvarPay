import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Task} from '@a2a-js/sdk';
import {loadCommerceConfig} from '../dist/commerce/index.js';
import {CommerceStore,CommerceServer,bearerAuthenticator} from '../dist/commerce/runtime.js';

const tokenA='a'.repeat(40),tokenB='b'.repeat(40),origin='http://127.0.0.1:19410';
const path='/services/summary-preview/v1/offers/free/a2a';
const request=(method,params,token=tokenA,url=path)=>new Request(origin+url,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token,'A2A-Version':'1.0'},body:JSON.stringify({jsonrpc:'2.0',id:'rpc-1',method,params})});
const message=(text='hello',id='m-1')=>({message:{messageId:id,role:'ROLE_USER',parts:[{data:{text}}]},configuration:{returnImmediately:true}});
function fixture(executor){
 const store=new CommerceStore(':memory:');const config=loadCommerceConfig(JSON.parse(readFileSync(new URL('../examples/seller.json',import.meta.url),'utf8')));
 const server=new CommerceServer({config,origin,store,authenticate:bearerAuthenticator({[tokenA]:'buyer-a',[tokenB]:'buyer-b'}),execute:executor});
 return {server,store};
}
async function stop(server,store){server.stop();while(server.isRunning)await new Promise(r=>setTimeout(r,5));store.close();}

test('standard A2A Card, authenticated free execution, replay and owner-only GetTask',async()=>{
 let calls=0;
 const {server,store}=fixture(async function*(order){calls++;yield Task.fromJSON({id:'remote-'+order.id,contextId:'upstream-context',status:{state:'TASK_STATE_COMPLETED'},artifacts:[{artifactId:'result',parts:[{text:order.input.text}]}]});});
 try{
  const card=await(await server.handle(new Request(origin+path.replace('/a2a','/agent-card.json')))).json();assert.equal(card.supportedInterfaces[0].protocolVersion,'1.0');
  assert.equal((await server.handle(request('SendMessage',message(),'bad'))).status,401);
  const response=await(await server.handle(request('SendMessage',message()))).json();assert.ok(response.result?.task,JSON.stringify(response));const taskId=response.result.task.id;
  while(server.isRunning)await new Promise(r=>setTimeout(r,5));
  const completed=await(await server.handle(request('GetTask',{id:taskId}))).json();assert.equal(completed.result.status.state,'TASK_STATE_COMPLETED');assert.equal(completed.result.artifacts[0].parts[0].text,'hello');
  const replay=await(await server.handle(request('SendMessage',message()))).json();assert.equal(replay.result.task.id,taskId);assert.equal(calls,1);
  const forbidden=await(await server.handle(request('GetTask',{id:taskId},tokenB))).json();assert.ok(forbidden.error);
  const conflict=await(await server.handle(request('SendMessage',message('different')))).json();assert.ok(conflict.error);assert.equal(calls,1);
 }finally{await stop(server,store);}
});
test('invalid input and paid offer cannot execute without payment transport',async()=>{
 let calls=0;const {server,store}=fixture(async function*(){calls++;});
 try{
  const invalid=await(await server.handle(request('SendMessage',message('x'.repeat(501))))).json();assert.ok(invalid.error);
  const paid={message:{messageId:'paid',role:'ROLE_USER',parts:[{data:{topic:'x',competitors:['A']}}]},configuration:{returnImmediately:true}};
  const refused=await(await server.handle(request('SendMessage',paid,tokenA,'/services/research/v1/offers/usdc-once/a2a'))).json();assert.ok(refused.error);assert.equal(calls,0);
 }finally{await stop(server,store);}
});
test('runtime error is durable unknown and replay never dispatches a second task',async()=>{
 let calls=0;const {server,store}=fixture(async function*(){calls++;throw new Error('network response lost');});
 try{
  const first=await(await server.handle(request('SendMessage',message()))).json();assert.ok(first.result.task);
  while(server.isRunning)await new Promise(r=>setTimeout(r,5));
  assert.equal(store.findOrder('buyer-a','summary-preview:1','m-1').executionState,'unknown');
  const second=await(await server.handle(request('SendMessage',message()))).json();assert.equal(second.result.task.id,first.result.task.id);assert.equal(calls,1);
 }finally{await stop(server,store);}
});
