import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Task, AgentCard} from '@a2a-js/sdk';
import {buildQuote, createOfferCard, digest, loadCommerceConfig} from '../dist/commerce/index.js';
import {CommerceServer, CommerceStore, bearerAuthenticator, createSkillCard, createSkillRegistry, skillScopedExecutor} from '../dist/commerce/runtime.js';

const origin='http://127.0.0.1:19442', token='s'.repeat(40), skillDigest='a'.repeat(64);
const raw=()=>JSON.parse(readFileSync(new URL('../examples/seller.json',import.meta.url),'utf8'));
function config() {
  const source=raw(), service=source.services.find(s=>s.id==='summary-preview');
  source.configVersion=2;
  service.id=service.name='research';
  service.execution={type:'skill',cardUrl:'http://127.0.0.1:9111/research/agent-card.json',skillDigest};
  source.services=[service];
  return loadCommerceConfig(source);
}
const task=(id)=>Task.fromJSON({id,status:{state:'TASK_STATE_COMPLETED'},artifacts:[{artifactId:'result',parts:[{text:'research completed'}]}]});
function request(id='m1', offer='free', paid=false) {
  return new Request(origin+`/services/research/v1/offers/${offer}/a2a`,{
    method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token,'A2A-Version':'1.0',...(paid?{'X-Fixture-Payment':'confirmed'}:{})},
    body:JSON.stringify({jsonrpc:'2.0',id:'rpc-1',method:'SendMessage',params:{message:{messageId:id,role:'ROLE_USER',parts:[{data:{text:'research public sources'}}]},configuration:{returnImmediately:true}}}),
  });
}
async function stop(server,store){server.stop();while(server.isRunning)await new Promise(r=>setTimeout(r,5));store.close();}

test('name is the skill identity; a generic A2A executor cannot sell a version-2 skill',()=>{
  const c=config();
  const generic=async function*(){yield task('generic');};
  const store=new CommerceStore(':memory:');
  try{
    assert.throws(()=>new CommerceServer({config:c,origin,store,authenticate:bearerAuthenticator({[token]:'buyer'}),execute:generic}),/enforcing skill runtime/);
  }finally{store.close();}
  const wrong=raw();wrong.configVersion=2;wrong.services=[{...c.services[0],name:'Do research'}];
  assert.throws(()=>loadCommerceConfig(wrong),/exact installed skill name/);
  const legacy=raw();legacy.services[0].execution=c.services[0].execution;
  assert.throws(()=>loadCommerceConfig(legacy),/configVersion 2/);
});

test('a priced skill waits for an independently confirmed gate before its exact-name dispatch',async()=>{
  const c=config();
  c.services[0].offers.push({id:'paid',pricing:{kind:'fixed',amount:'100000'},collection:{kind:'upfront'},paymentProfile:'base-usdc'});
  let calls=0;
  const runtime={
    list:()=>[{name:'research',digest:skillDigest,cardUrl:c.services[0].execution.cardUrl,access:'paid'}],
    async send(name,input,{grant}){calls++;assert.equal(name,'research');assert.equal(input.text,'research public sources');grant.require('research');assert.throws(()=>grant.require('short-drama'),error=>error.code==='skill_payment_required');return task('paid-skill-task');},
    async getTask(){return task('paid-skill-task');},
  };
  const store=new CommerceStore(':memory:');
  const server=new CommerceServer({config:c,origin,store,authenticate:bearerAuthenticator({[token]:'buyer'}),execute:skillScopedExecutor(runtime),paymentGate:{
    async handle(req,order){
      if(req.headers.get('X-Fixture-Payment')!=='confirmed')return {response:Response.json({fixture:'unpaid'},{status:402})};
      if(order.paymentState!=='confirmed'){
        const attempt=store.reservePayment(order.id,order.caller,'fixture:'+order.id,'fixture-vault-ref');
        store.recordSettlement(attempt,'confirmed',{fixture:true});
      }
      return {headers:{}};
    },
  }});
  try{
    const unpaid=await server.handle(request('paid-message','paid'));
    assert.equal(unpaid.status,402);assert.equal(calls,0);
    const paid=await(await server.handle(request('paid-message','paid',true))).json();assert.ok(paid.result?.task);
    while(server.isRunning)await new Promise(r=>setTimeout(r,5));
    const order=store.findOrder('buyer','research:1','paid-message');
    assert.equal(order.paymentState,'confirmed');assert.equal(order.executionState,'completed');assert.equal(calls,1);
    await server.handle(request('paid-message','paid',true));while(server.isRunning)await new Promise(r=>setTimeout(r,5));assert.equal(calls,1);
  }finally{await stop(server,store);}
});

test('skill version is frozen into quote and public A2A Card terms',()=>{
  const c=config(), service=c.services[0], offer=service.offers[0];
  const quote=buildQuote(c,{serviceId:'research',offerId:'free',caller:'buyer',messageId:'m1',input:{text:'research public sources'}});
  const card=AgentCard.toJSON(createOfferCard(c,'research','free',origin));
  const extension=card.capabilities.extensions.find(x=>x.uri==='urn:envarpay:commerce:1');
  assert.equal(extension.params.skillDigest,skillDigest);
  assert.equal(extension.params.termsDigest,quote.termsDigest);
  const changed=structuredClone(c);changed.services[0].execution.skillDigest='b'.repeat(64);
  const changedQuote=buildQuote(changed,{serviceId:'research',offerId:'free',caller:'buyer',messageId:'m1',input:{text:'research public sources'}});
  assert.notEqual(changedQuote.termsDigest,quote.termsDigest);
  assert.equal(quote.inputDigest,digest({text:'research public sources'}));
});

test('the private A2A skill Card advertises one exact installed name and digest',()=>{
  const descriptor={name:'short-drama',digest:skillDigest,cardUrl:'http://127.0.0.1:9111/short-drama/agent-card.json',access:'paid'};
  const card=AgentCard.toJSON(createSkillCard(descriptor,'http://127.0.0.1:9111/short-drama/a2a'));
  assert.deepEqual(card.skills.map(s=>s.id),['short-drama']);
  const extension=card.capabilities.extensions.find(x=>x.uri==='urn:envarpay:skill-gate:1');
  assert.equal(extension.params.skillName,'short-drama');assert.equal(extension.params.skillDigest,skillDigest);
  assert.throws(()=>createSkillCard(descriptor,'http://other.example/a2a'),/same-origin/);
});

test('free A2A purchase invokes only its same-name skill; another paid skill needs another purchase',async()=>{
  const c=config(), descriptors=[
    {name:'research',digest:skillDigest,cardUrl:c.services[0].execution.cardUrl,access:'paid'},
    {name:'free-helper',digest:'b'.repeat(64),cardUrl:'http://127.0.0.1:9111/free/agent-card.json',access:'free'},
    {name:'short-drama',digest:'c'.repeat(64),cardUrl:'http://127.0.0.1:9111/drama/agent-card.json',access:'paid'},
  ];
  let calls=0, nestedDenied=false;
  const runtime={
    list:()=>descriptors,
    async send(name,input,{grant}){
      calls++;assert.equal(name,'research');assert.equal(input.text,'research public sources');
      grant.require('research');grant.require('free-helper');
      assert.throws(()=>grant.require('short-drama'),error=>error.code==='skill_payment_required');nestedDenied=true;
      return task('skill-task-1');
    },
    async getTask(){return task('skill-task-1');},
  };
  const store=new CommerceStore(':memory:');
  const server=new CommerceServer({config:c,origin,store,authenticate:bearerAuthenticator({[token]:'buyer'}),execute:skillScopedExecutor(runtime)});
  try{
    const first=await(await server.handle(request())).json();assert.ok(first.result?.task);
    while(server.isRunning)await new Promise(r=>setTimeout(r,5));
    const order=store.findOrder('buyer','research:1','m1');
    assert.equal(order.paymentState,'not_required');assert.equal(order.executionState,'completed');
    assert.equal(calls,1);assert.equal(nestedDenied,true);
    await server.handle(request());while(server.isRunning)await new Promise(r=>setTimeout(r,5));assert.equal(calls,1);
    descriptors[0].digest='d'.repeat(64);
    const stale=await(await server.handle(request('m2'))).json();assert.ok(stale.error);assert.equal(calls,1);
  }finally{await stop(server,store);}
});

test('reference registry enforces nested free versus paid skill calls',async()=>{
  const c=config(), order={
    id:'order-1',caller:'buyer',messageId:'m1',inputDigest:digest({text:'research public sources'}),
    input:{text:'research public sources'},offerId:'free',serviceRevision:'research:1',taskId:'seller-task-1',
    quote:{},paymentState:'not_required',executionState:'queued',
  };
  const observed=[];
  const runtime=createSkillRegistry([
    {descriptor:{name:'research',digest:skillDigest,cardUrl:c.services[0].execution.cardUrl,access:'paid'},
      async send(input,ctx){observed.push('research');await ctx.callSkill('free-helper',input);await assert.rejects(ctx.callSkill('short-drama',input),e=>e.code==='skill_payment_required');return task('research-task');},
      async getTask(){return task('research-task');}},
    {descriptor:{name:'free-helper',digest:'b'.repeat(64),cardUrl:'http://127.0.0.1:9111/free/agent-card.json',access:'free'},
      async send(){observed.push('free-helper');return task('free-task');},async getTask(){return task('free-task');}},
    {descriptor:{name:'short-drama',digest:'c'.repeat(64),cardUrl:'http://127.0.0.1:9111/drama/agent-card.json',access:'paid'},
      async send(){observed.push('short-drama');return task('drama-task');},async getTask(){return task('drama-task');}},
  ]);
  const stream=skillScopedExecutor(runtime)(order,c.services[0]);
  for await(const result of stream)assert.equal(Task.toJSON(result).status.state,'TASK_STATE_COMPLETED');
  assert.deepEqual(observed,['research','free-helper']);
});
