import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request as httpRequest} from 'node:http';
import {readFileSync} from 'node:fs';
import {once} from 'node:events';
import {Task,AgentCard} from '@a2a-js/sdk';
import {loadCommerceConfig} from '../dist/commerce/index.js';
import {CommerceStore,CommerceServer,bearerAuthenticator,listenCommerce,nativeA2AExecutor} from '../dist/commerce/runtime.js';

test('real HTTP server accepts official A2A request and enforces Host/auth',async()=>{
 const reserve=createServer();reserve.listen(0,'127.0.0.1');await once(reserve,'listening');const port=reserve.address().port;await new Promise(r=>reserve.close(r));
 const origin=`http://127.0.0.1:${port}`;const store=new CommerceStore(':memory:');const token='a'.repeat(40);
 const config=loadCommerceConfig(JSON.parse(readFileSync(new URL('../examples/seller.json',import.meta.url),'utf8')));
 const server=new CommerceServer({config,origin,store,authenticate:bearerAuthenticator({[token]:'buyer'}),execute:async function*(order){yield Task.fromJSON({id:'remote-1',status:{state:'TASK_STATE_COMPLETED'},artifacts:[{artifactId:'a',parts:[{text:order.input.text}]}]});}});
 const http=listenCommerce(server,origin,'127.0.0.1',port);await once(http,'listening');
 try{
  const url=origin+'/services/summary-preview/v1/offers/free/a2a';
  const response=await fetch(url,{method:'POST',headers:{Authorization:'Bearer '+token,'A2A-Version':'1.0','Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'SendMessage',params:{message:{messageId:'m1',role:'ROLE_USER',parts:[{data:{text:'actual-http'}}]},configuration:{returnImmediately:true}}})});
  assert.equal(response.status,200);assert.ok((await response.json()).result.task.id);
  assert.equal((await fetch(url,{method:'POST'})).status,401);
  const invalidHostStatus=await new Promise((resolve,reject)=>{const r=httpRequest(url,{method:'POST',headers:{Host:'evil.example'}},response=>{response.resume();resolve(response.statusCode);});r.on('error',reject);r.end();});
  assert.equal(invalidHostStatus,421);
 }finally{server.stop();await new Promise(r=>http.close(r));while(server.isRunning)await new Promise(r=>setTimeout(r,5));store.close();}
});

test('native A2A executor uses official client and rejects cross-origin Card credentials',async()=>{
 const service={id:'summary-preview',execution:{cardUrl:'http://runtime.local/card.json'},contract:{targetDurationSeconds:3}};
 const order={id:'o',messageId:'m',input:{text:'hello'}};
 const seen=[];
 const card={name:'runtime',description:'test',version:'1',capabilities:{},defaultInputModes:['application/json'],defaultOutputModes:['text/plain'],skills:[{id:'s',name:'s',description:'s',tags:[]}],supportedInterfaces:[{url:'http://runtime.local/a2a',protocolBinding:'JSONRPC',protocolVersion:'1.0'}]};
 const transport=async input=>{const req=new Request(input);seen.push({url:req.url,auth:req.headers.get('Authorization')});if(req.method==='GET')return Response.json(card);const rpc=await req.json();assert.equal(rpc.method,'SendMessage');assert.deepEqual(rpc.params.message.parts[0].data,order.input);return Response.json({jsonrpc:'2.0',id:rpc.id,result:{task:{id:'remote-task',contextId:'ctx',status:{state:'TASK_STATE_COMPLETED'},artifacts:[]}}});};
 const events=[];for await(const task of nativeA2AExecutor({'summary-preview':'runtime-token-000000'},transport)(order,service))events.push(task);
 assert.equal(events[0].id,'remote-task');assert.equal(seen.length,2);assert.equal(seen[1].auth,'Bearer runtime-token-000000');
 const bad=structuredClone(card);bad.supportedInterfaces[0].url='http://another-origin/a2a';let calls=0;
 await assert.rejects(async()=>{for await(const _ of nativeA2AExecutor({'summary-preview':'runtime-token-000000'},async()=>{calls++;return Response.json(AgentCard.toJSON(AgentCard.fromJSON(bad)));})(order,service))void _;});
 assert.equal(calls,1);
});

test('native input encoding is explicit for initial and continuation requests, never a fallback',async()=>{
 const service={id:'assistant-request',revision:1,execution:{cardUrl:'http://runtime.local/card.json'},contract:{targetDurationSeconds:3}};
 const order={id:'order',messageId:'initial-message',input:{request:'Use native text mode',language:'zh'}};
 const remote={origin:service.execution.cardUrl,taskId:'original-task',contextId:'original-context',interfaceUrl:'http://runtime.local/a2a'};
 const card={name:'native',description:'bounded assistant request',version:'1',capabilities:{},defaultInputModes:['text/plain'],defaultOutputModes:['text/plain'],skills:[],supportedInterfaces:[{url:remote.interfaceUrl,protocolBinding:'JSONRPC',protocolVersion:'1.0'}]};
 for(const mode of [undefined,'data','json-text']){
  const calls=[];const transport=async input=>{const request=new Request(input);if(request.method==='GET')return Response.json(card);const rpc=await request.json();calls.push(rpc);return Response.json({jsonrpc:'2.0',id:rpc.id,result:{task:{id:'original-task',contextId:'original-context',status:{state:'TASK_STATE_COMPLETED'}}}});};
  const execute=nativeA2AExecutor({'assistant-request':'runtime-token-000000'},transport,undefined,{inputEncoding:mode?{'assistant-request':mode}:{}});
  for await(const _ of execute(order,service))void _;
  for await(const _ of execute.continue(order,service,{messageId:'clarification-message',input:{...order.input,clarification:'One paragraph'}},remote))void _;
  assert.equal(calls[0].params.message.messageId,'initial-message');assert.equal(calls[0].params.message.taskId,undefined);
  assert.equal(calls[1].params.message.messageId,'clarification-message');assert.equal(calls[1].params.message.taskId,'original-task');assert.equal(calls[1].params.message.contextId,'original-context');
  if(mode==='json-text'){assert.deepEqual(JSON.parse(calls[0].params.message.parts[0].text),order.input);assert.equal(calls[0].params.message.parts[0].data,undefined);assert.equal(JSON.parse(calls[1].params.message.parts[0].text).clarification,'One paragraph');}
  else{assert.deepEqual(calls[0].params.message.parts[0].data,order.input);assert.equal(calls[0].params.message.parts[0].text,undefined);}
 }
 let sends=0;const rejected=nativeA2AExecutor({'assistant-request':'runtime-token-000000'},async input=>{const request=new Request(input);if(request.method==='GET')return Response.json(card);sends++;return Response.json({jsonrpc:'2.0',id:(await request.json()).id,error:{code:-32602,message:'encoding not accepted'}});});
 await assert.rejects(async()=>{for await(const _ of rejected(order,service))void _;});assert.equal(sends,1);
 assert.throws(()=>nativeA2AExecutor({},fetch,undefined,{inputEncoding:{'assistant-request':'automatic'}}),/explicit/);
});
