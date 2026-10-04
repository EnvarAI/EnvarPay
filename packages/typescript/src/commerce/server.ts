import { timingSafeEqual } from 'node:crypto';
import { AgentCard, GetTaskRequest, Role, Task, TaskState, SendMessageRequest, type StreamResponse } from '@a2a-js/sdk';
import { DefaultRequestHandler, JsonRpcTransportHandler, ServerCallContext, type AgentExecutor } from '@a2a-js/sdk/server';
import { RequestMalformedError, TaskNotFoundError, UnsupportedOperationError } from '@a2a-js/sdk/errors';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsImport from 'ajv-formats';
import { createOfferCard, offerPath } from './card.js';
import { digest, loadCommerceConfig } from './config.js';
import { buildQuote } from './pricing.js';
import { CommerceStore, type OrderRecord, type ContinuationRecord, type RemoteTaskReference } from './store.js';
import { CommerceError, type CommerceConfig, type Input, type Service } from './types.js';

export interface ExecuteOrder {
  (order:OrderRecord,service:Service):AsyncIterable<Task>;
  continue?:(order:OrderRecord,service:Service,continuation:ContinuationRecord,remote:RemoteTaskReference)=>AsyncIterable<Task>;
  recover?:(order:OrderRecord,service:Service,remote:RemoteTaskReference)=>Promise<Task>;
  remoteInterface?:(task:Task)=>string|undefined;
}
export interface CommerceServerOptions {
  config: CommerceConfig;
  origin: string;
  store: CommerceStore;
  authenticate: (request:Request)=>Promise<string|null>;
  execute: ExecuteOrder;
  paymentGate?:{handle(request:Request,order:OrderRecord):Promise<{response:Response}|{headers:Record<string,string>}>};
  stripeRecipientFor?:(accountRef:string)=>string|undefined;
  ownershipChallenges?:Readonly<Record<string,string>>;
  onError?: (code:string,orderId?:string)=>void;
}
const TERMINAL=[TaskState.TASK_STATE_COMPLETED,TaskState.TASK_STATE_FAILED,TaskState.TASK_STATE_CANCELED,TaskState.TASK_STATE_REJECTED];
const WAITING=[TaskState.TASK_STATE_INPUT_REQUIRED,TaskState.TASK_STATE_AUTH_REQUIRED];
const addFormats=addFormatsImport as unknown as (ajv:Ajv2020)=>void;

export function bearerAuthenticator(tokens:Readonly<Record<string,string>>):(request:Request)=>Promise<string|null> {
  const entries=Object.entries(tokens);
  if(!entries.length||entries.some(([token,caller])=>token.length<32||!caller)) throw new CommerceError('invalid_credentials','Configure strong distinct caller tokens');
  return async(request)=>{
    const candidate=request.headers.get('Authorization')?.replace(/^Bearer /,'')??'';
    const value=Buffer.from(candidate);let found:string|null=null;
    for(const [token,caller] of entries){const expected=Buffer.from(token);if(value.length===expected.length&&timingSafeEqual(value,expected))found=caller;}
    return found;
  };
}

function structuredInput(params:SendMessageRequest):Input {
  const m=params.message;
  if(!m||m.role!==Role.ROLE_USER||!m.messageId||m.messageId.length>128||m.parts.length!==1||m.referenceTaskIds.length||(!m.taskId&&m.contextId)) throw new RequestMalformedError('Commerce requires one user data part and a stable messageId; continuations need the original Task ID');
  const p=m.parts[0]!.content;
  if(p?.$case!=='data'||!p.value||typeof p.value!=='object'||Array.isArray(p.value))throw new RequestMalformedError('Provide the service JSON input in one data part');
  return p.value as Input;
}

function validateBeforePayment(raw:Record<string,unknown>):void {
  if(raw.jsonrpc!=='2.0'||!['string','number'].includes(typeof raw.id)||raw.id===''||(typeof raw.id==='number'&&!Number.isSafeInteger(raw.id)))throw new RequestMalformedError('Valid JSONRPC request ID required');
  const params=raw.params as Record<string,unknown>|undefined;
  const message=params?.message as Record<string,unknown>|undefined;
  if(!message||typeof message.messageId!=='string'||message.role!=='ROLE_USER'||!Array.isArray(message.parts))throw new RequestMalformedError('A valid user Message is required');
  if(message.taskId!==undefined&&(typeof message.taskId!=='string'||!message.taskId))throw new RequestMalformedError('Task ID must be a nonempty string');
  if(message.contextId!==undefined&&(typeof message.contextId!=='string'||!message.contextId))throw new RequestMalformedError('Context ID must be a nonempty string');
  if(message.parts.length!==1||!message.parts[0]||typeof message.parts[0]!=='object'||Object.keys(message.parts[0]).some(x=>!['data','mediaType'].includes(x)))throw new RequestMalformedError('Commerce accepts exactly one structured data part');
  if(params?.metadata||message.metadata||message.extensions)throw new UnsupportedOperationError('Unrecognized execution metadata is not accepted by this service');
  const configuration=params?.configuration as Record<string,unknown>|undefined;
  if(configuration){
    if(typeof configuration!=='object'||Array.isArray(configuration)||Object.keys(configuration).some(k=>!['returnImmediately','acceptedOutputModes','historyLength'].includes(k)))throw new UnsupportedOperationError('Unsupported request configuration');
    if(configuration.returnImmediately!==undefined&&typeof configuration.returnImmediately!=='boolean')throw new RequestMalformedError('returnImmediately must be boolean');
    if(configuration.historyLength!==undefined&&(!Number.isInteger(configuration.historyLength)||(configuration.historyLength as number)<0))throw new RequestMalformedError('historyLength must be a nonnegative integer');
    if(configuration.acceptedOutputModes!==undefined&&(!Array.isArray(configuration.acceptedOutputModes)||configuration.acceptedOutputModes.some(x=>typeof x!=='string')))throw new RequestMalformedError('acceptedOutputModes must be strings');
  }
}

/** Clarifications may only fill explicitly declared absent fields of the initial contract. */
function clarification(service:Service,offerId:string,current:Input,patch:Input):Input {
  let added=0;
  const offer=service.offers.find(o=>o.id===offerId)!;
  const quantity=offer.pricing.kind==='quantity'?offer.pricing.quantity.pointer:null;
  const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
  const merge=(before:Record<string,unknown>,changes:Record<string,unknown>,schema:Record<string,unknown>,path:string):Record<string,unknown>=>{
    const result=structuredClone(before);
    for(const [key,value] of Object.entries(changes)){
      if(['__proto__','prototype','constructor'].includes(key))throw new CommerceError('invalid_clarification','Reserved input property');
      const pointer=path+'/'+key.replace(/~/g,'~0').replace(/\//g,'~1');
      const properties=schema.properties as Record<string,Record<string,unknown>>|undefined;
      if(Object.hasOwn(before,key)){
        if(digest(before[key])===digest(value))continue;
        if(object(before[key])&&object(value)&&properties?.[key]){result[key]=merge(before[key],value,properties[key],pointer);continue;}
        throw new CommerceError('scope_changed','Previously supplied input cannot change during the purchased task');
      }
      if(!properties||!Object.hasOwn(properties,key))throw new CommerceError('scope_changed','Clarification must fill an explicitly declared input field');
      if(quantity&&(pointer===quantity||pointer.startsWith(quantity+'/')||quantity.startsWith(pointer+'/')))throw new CommerceError('price_changed','Priced quantity cannot change during clarification');
      result[key]=value;added++;
    }
    return result;
  };
  const merged=merge(current,patch,service.contract.inputSchema,'') as Input;
  if(!added)throw new CommerceError('empty_clarification','Add a previously absent clarification field');
  const ajv=new Ajv2020({strict:true});addFormats(ajv);
  if(!ajv.compile(service.contract.inputSchema)(merged))throw new CommerceError('invalid_clarification','Clarified input does not match the original service schema');
  return merged;
}

class OrderHandler extends DefaultRequestHandler {
  constructor(private host:CommerceServer,private service:Service,private offerId:string,card:AgentCard,store:CommerceStore,private active:boolean){
    const executor:AgentExecutor={execute:async()=>{throw new UnsupportedOperationError('Use commerce order dispatch');},cancelTask:async()=>{throw new UnsupportedOperationError('Runtime cancellation is not available');}};
    super(card,store,executor);
  }
  override async sendMessage(params:SendMessageRequest,context:ServerCallContext):Promise<Task>{
    if(params.configuration?.taskPushNotificationConfig)throw new UnsupportedOperationError('Push notifications are not supported');
    const caller=context.user?.isAuthenticated?context.user.userName:undefined;
    if(!caller)throw new RequestMalformedError('Authenticated buyer required');
    const input=structuredInput(params);
    if(params.message!.taskId)return this.host.continueTask(params,input,this.service,this.offerId,context);
    const prior=this.host.store.findOrder(caller,`${this.service.id}:${this.service.revision}`,params.message!.messageId);
    if(prior){
      if(prior.inputDigest!==digest(input)||prior.offerId!==this.offerId)throw new RequestMalformedError('Message ID already identifies a different purchase');
      const original=await this.host.store.load(prior.taskId,context);
      if(original)return original;
    }
    if(!this.active)throw new UnsupportedOperationError('This service revision is retired; existing Tasks remain readable');
    const order=this.host.store.ensureQuote(this.host.quote(this.service,this.offerId,caller,params.message!.messageId,input),input);
    if(order.paymentState==='confirmed'){
      const task=await this.host.store.load(order.taskId,context);
      if(!task)throw new CommerceError('task_recovery_required','Paid task record is incomplete');
      this.host.schedule();return task;
    }
    if(order.paymentState!=='not_required')throw new UnsupportedOperationError('Payment transport must be enabled before this paid offer can execute');
    const task=this.host.store.enqueueFree(order.id,caller);this.host.schedule();
    return params.configuration?.returnImmediately===true?task:this.host.waitForTask(order.taskId,context);
  }
  override async getTask(params:GetTaskRequest,context:ServerCallContext):Promise<Task>{
    const task=await this.host.recoverTask(params.id,context);
    if(params.historyLength!==undefined){if(params.historyLength<0)throw new RequestMalformedError('historyLength must be nonnegative');task.history=params.historyLength===0?[]:task.history.slice(-params.historyLength);}
    return task;
  }
  override async *sendMessageStream():AsyncGenerator<StreamResponse> {throw new UnsupportedOperationError('Streaming is not available on this commerce entry');}
  override async *resubscribe():AsyncGenerator<StreamResponse> {throw new UnsupportedOperationError('Task subscriptions are not available on this commerce entry');}
}

/** HTTP handler + one durable worker. Recovery only reads the original upstream Task. */
export class CommerceServer {
  private currentConfig:CommerceConfig;
  get config():CommerceConfig {return structuredClone(this.currentConfig);}
  readonly store:CommerceStore;
  private routes=new Map<string,{card:AgentCard;rpc:JsonRpcTransportHandler;tenant:string;service:Service;offerId:string;active:boolean}>();
  private running=false;
  private kickPending=false;
  private stopped=false;
  private workerFailed=false;
  private waiters=new Map<string,Set<()=>void>>();
  private activeOrders=new Set<string>();
  private recoveries=new Map<string,Promise<void>>();
  constructor(private options:CommerceServerOptions){
    this.currentConfig=loadCommerceConfig(options.config);this.store=options.store;
    this.applyConfig(this.currentConfig);
    this.store.recoverInterruptedDispatches();this.schedule();
  }
  /** Atomically replace active routes while retaining immutable history and original Tasks. */
  applyConfig(value:CommerceConfig):void {
    if(this.stopped)throw new CommerceError('server_draining','Cannot apply configuration while stopping');
    const config=loadCommerceConfig(value);
    if(config.agent.id!==this.currentConfig.agent.id)throw new CommerceError('config_agent_changed','Runtime Agent identity cannot change');
    const history=this.store.catalogHistory();
    for(const service of config.services){
      const maximum=Math.max(0,...history.filter(h=>h.service.id===service.id).map(h=>h.service.revision));
      if(service.revision<maximum)throw new CommerceError('stale_revision','An older service revision cannot become active');
    }
    const snapshots=new Map(history.map(entry=>[`${entry.service.id}:${entry.service.revision}`,entry]));
    for(const service of config.services){const profiles=Object.fromEntries(service.offers.filter(o=>o.paymentProfile).map(o=>[o.paymentProfile!,config.paymentProfiles[o.paymentProfile!]]));const key=`${service.id}:${service.revision}`,prior=snapshots.get(key);
      if(prior&&digest(prior)!==digest({service,profiles}))throw new CommerceError('immutable_revision','Service revision terms are immutable');
      snapshots.set(key,{service,profiles});}
    const routes=new Map<string,{card:AgentCard;rpc:JsonRpcTransportHandler;tenant:string;service:Service;offerId:string;active:boolean}>();
    for(const entry of snapshots.values())for(const offer of entry.service.offers){
      const service=entry.service,historical={...config,paymentProfiles:entry.profiles,services:[service]};
      const card=createOfferCard(historical,service.id,offer.id,this.options.origin);
      const active=config.services.some(s=>s.id===service.id&&s.revision===service.revision);
      routes.set(offerPath(service.id,service.revision,offer.id),{card,rpc:new JsonRpcTransportHandler(new OrderHandler(this,service,offer.id,card,this.store,active)),tenant:`${service.id}:${service.revision}`,service,offerId:offer.id,active});
    }
    this.store.registerCatalog(config);
    this.currentConfig=config;this.routes=routes;
  }
  private activeRevision(service:Service):boolean {return this.currentConfig.services.some(s=>s.id===service.id&&s.revision===service.revision)}
  private context(caller:string,tenant:string):ServerCallContext {
    return new ServerCallContext({user:{isAuthenticated:true,userName:caller},tenant,requestedVersion:'1.0'});
  }
  quote(service:Service,offerId:string,caller:string,messageId:string,input:Input){
    if(!this.activeRevision(service))throw new CommerceError('retired_revision','This service revision is retired; recover original Tasks');
    const frozen=this.store.catalogHistory().find(entry=>entry.service.id===service.id&&entry.service.revision===service.revision);
    if(!frozen)throw new CommerceError('unknown_revision','Service revision is not registered');
    const config={...this.currentConfig,paymentProfiles:frozen.profiles,services:[frozen.service]},offer=frozen.service.offers.find(o=>o.id===offerId)!;
    const profile=offer.paymentProfile?frozen.profiles[offer.paymentProfile]:undefined;
    return buildQuote(config,{serviceId:service.id,offerId,caller,messageId,input,...(profile?.adapter==='mpp'?{stripeRecipient:this.options.stripeRecipientFor?.(profile.accountRef)}:{})});
  }
  async handle(request:Request):Promise<Response>{
    const url=new URL(request.url);
    if(url.origin!==new URL(this.options.origin).origin)return Response.json({error:'invalid_host'},{status:421});
    if(request.method==='GET'&&['/healthz','/readyz'].includes(url.pathname)){
      let ready=!this.stopped;
      if(url.pathname==='/readyz'){
        ready=ready&&!this.workerFailed;
        try{this.store.assertReady();}catch{ready=false;}
      }
      return Response.json({status:ready?'ready':this.stopped?'draining':'unavailable'},{status:ready?200:503,headers:{'Cache-Control':'no-store'}});
    }
    const proof=/^\/\.well-known\/envar\/([0-9a-f-]{36})$/.exec(url.pathname);
    if(request.method==='GET'&&proof){
      const challenge=this.options.ownershipChallenges?.[proof[1]!];
      if(!challenge)return Response.json({error:'not_found'},{status:404});
      return Response.json({agent_id:proof[1],challenge},{headers:{'Cache-Control':'no-store'}});
    }
    const base=url.pathname.replace(/\/(agent-card\.json|a2a)$/,'');
    const route=this.routes.get(base);
    if(!route)return Response.json({error:'not_found'},{status:404});
    if(request.method==='GET'&&url.pathname.endsWith('/agent-card.json'))return Response.json(AgentCard.toJSON(route.card),{headers:{'Cache-Control':'public, max-age=60'}});
    if(request.method!=='POST'||!url.pathname.endsWith('/a2a'))return Response.json({error:'method_not_allowed'},{status:405});
    if(this.stopped)return Response.json({error:'server_draining'},{status:503,headers:{'Retry-After':'5'}});
    const caller=await this.options.authenticate(request);
    if(!caller)return Response.json({error:'authentication_required'},{status:401,headers:{'WWW-Authenticate':'Bearer','Cache-Control':'no-store'}});
    if(request.headers.get('A2A-Version')!=='1.0')return Response.json({error:'A2A-Version 1.0 required'},{status:400});
    if(Number(request.headers.get('Content-Length')??0)>1024*1024)return Response.json({error:'request_too_large'},{status:413});
    let size=0;const chunks:Uint8Array[]=[];
    if(request.body){const reader=request.body.getReader();while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>1024*1024){await reader.cancel();return Response.json({error:'request_too_large'},{status:413});}chunks.push(value);}}
    const body=Buffer.concat(chunks).toString('utf8');let requestId:unknown=null;
    try{
      const raw=JSON.parse(body) as Record<string,unknown>;
      if(raw.method==='SendMessage'&&this.workerFailed)return Response.json({error:'worker_unavailable'},{status:503,headers:{'Cache-Control':'no-store'}});
      if(!raw||Array.isArray(raw)||typeof raw!=='object')throw new RequestMalformedError('A single JSONRPC object is required');
      requestId=raw.id??null;const params=raw.params;
      if(params&&typeof params==='object'&&'tenant' in params&&params.tenant!==route.tenant)return Response.json({jsonrpc:'2.0',id:raw.id??null,error:{code:-32602,message:'Invalid tenant'}},{status:200});
      let paymentHeaders:Record<string,string>={};
      if(raw.method==='SendMessage'){
        validateBeforePayment(raw);
        const message=SendMessageRequest.fromJSON(params as Record<string,unknown>);
        const input=structuredInput(message);
        // A taskId does not grant access: the handler verifies the original owner,
        // service/offer, confirmed payment and waiting state before any continuation.
        if(this.options.paymentGate&&!message.message!.taskId){
          const prior=this.store.findOrder(caller,route.tenant,message.message!.messageId);
          if(prior&&(prior.inputDigest!==digest(input)||prior.offerId!==route.offerId))throw new RequestMalformedError('Purchase request conflicts with the original');
          if(!prior&&!this.activeRevision(route.service))throw new UnsupportedOperationError('This service revision is retired');
          const order=prior??this.store.ensureQuote(this.quote(route.service,route.offerId,caller,message.message!.messageId,input),input);
          if(order.paymentState!=='not_required'){
            const gate=await this.options.paymentGate.handle(new Request(request.url,{method:'POST',headers:request.headers,body}),order);
            if('response' in gate)return gate.response;
            paymentHeaders=gate.headers;this.schedule();
          }
        }
      }
      const result=await route.rpc.handle(body,this.context(caller,route.tenant));
      if(Symbol.asyncIterator in result)return Response.json({jsonrpc:'2.0',id:raw.id??null,error:{code:-32004,message:'Streaming not available'}},{status:200});
      return Response.json(result,{headers:{'A2A-Version':'1.0','Cache-Control':'no-store',...paymentHeaders}});
    }catch(error){
      const mapped=error instanceof CommerceError?{code:-32000,message:error.message,data:{code:error.code}}:JsonRpcTransportHandler.mapToJSONRPCError(error);
      return Response.json({jsonrpc:'2.0',id:requestId,error:mapped},{headers:{'Cache-Control':'no-store'}});
    }
  }
  async continueTask(params:SendMessageRequest,input:Input,service:Service,offerId:string,context:ServerCallContext):Promise<Task>{
    const m=params.message!,caller=context.user!.userName;
    const order=this.store.orderForTask(m.taskId,caller,context.tenant??'');
    const original=order?await this.store.load(order.taskId,context):undefined;
    if(!order||!original||order.offerId!==offerId)throw new TaskNotFoundError('Original Task not found on this offer');
    if(m.contextId&&m.contextId!==original.contextId)throw new RequestMalformedError('Context does not match the original Task');
    const existing=this.store.continuationFor(order.id,m.messageId);
    if(existing){if(existing.requestDigest!==digest(input))throw new RequestMalformedError('Clarification message ID already identifies different input');return original;}
    if(!this.options.execute.continue)throw new UnsupportedOperationError('This executor does not support scoped Task continuation');
    if(this.activeOrders.has(order.id)||this.recoveries.has(order.id))throw new CommerceError('task_busy','Wait for the current Task observation to finish');
    if(!this.store.remoteTask(order.id,caller))throw new CommerceError('task_recovery_required','No original remote Task is available');
    const merged=clarification(service,offerId,this.store.clarificationInput(order.id),input);
    this.store.enqueueContinuation(order.id,caller,m.messageId,input,merged);this.schedule();
    return params.configuration?.returnImmediately===true?(await this.store.load(order.taskId,context))!:this.waitForTask(order.taskId,context);
  }
  async recoverTask(taskId:string,context:ServerCallContext):Promise<Task>{
    const original=await this.store.load(taskId,context);
    if(!original)throw new TaskNotFoundError('Task not found');
    const order=this.store.orderForTask(taskId,context.user!.userName,context.tenant??'');
    if(!order||TERMINAL.includes(original.status?.state??0)||this.activeOrders.has(order.id)||order.executionState==='queued'||!this.options.execute.recover)return original;
    const remote=this.store.remoteTask(order.id,order.caller),service=this.store.serviceRevision(order.serviceRevision);
    if(!remote||!service)return original;
    let pending=this.recoveries.get(order.id);
    if(!pending){
      pending=(async()=>{
        try{
          const task=await this.options.execute.recover!(order,service,remote);
          this.store.recordRemoteTask(order.id,remote.origin,task.id,task.contextId,this.options.execute.remoteInterface?.(task)??remote.interfaceUrl);
          this.store.acknowledgeRecoveredContinuations(order.id,task);
          const projected=this.project(task,original,order);
          await this.store.save(projected,context);this.wake(taskId);
        }catch(error){this.options.onError?.(error instanceof CommerceError?error.code:'recovery_unavailable',order.id);}
      })().finally(()=>this.recoveries.delete(order.id));
      this.recoveries.set(order.id,pending);
    }
    await pending;return (await this.store.load(taskId,context))!;
  }
  private project(remote:Task,original:Task,order:OrderRecord):Task {
    const projected=Task.fromJSON({...Task.toJSON(remote) as Record<string,unknown>,id:order.taskId,contextId:original.contextId});
    for(const m of [...projected.history,...(projected.status?.message?[projected.status.message]:[])]){
      if(m.taskId===remote.id)m.taskId=order.taskId;if(m.contextId===remote.contextId)m.contextId=original.contextId;
    }
    const metadata={...projected.metadata};delete metadata.recoveryRequired;delete metadata.executionState;delete metadata.clarificationPending;
    if(this.store.hasUnresolvedContinuation(order.id)){metadata.recoveryRequired=true;metadata.clarificationPending=true;}
    projected.metadata=metadata;return projected;
  }
  schedule():void {
    if(this.stopped||this.workerFailed)return;
    if(this.running){this.kickPending=true;return;}
    this.running=true;
    void this.drain().catch(()=>{this.workerFailed=true;this.options.onError?.('worker_failure');}).finally(()=>{this.running=false;if(this.kickPending){this.kickPending=false;this.schedule();}});
  }
  private async drain():Promise<void>{
    while(!this.stopped){
      const continued=this.store.claimContinuation();const order=continued?.order??this.store.claimReady();if(!order)return;
      const service=this.store.serviceRevision(order.serviceRevision),context=this.context(order.caller,order.serviceRevision);
      const original=await this.store.load(order.taskId,context);
      if(!service||!original){if(continued)this.store.unknownContinuation(continued.continuation.id);this.store.markExecutionUnknown(order.id);this.wake(order.taskId);continue;}
      this.activeOrders.add(order.id);
      try{
        const reference=this.store.remoteTask(order.id,order.caller);
        if(continued&&(!reference||!this.options.execute.continue))throw new CommerceError('continuation_unavailable','Original continuation executor is unavailable');
        const stream=continued?this.options.execute.continue!(order,service,continued.continuation,reference!):this.options.execute(order,service);
        let observed=false;
        for await(const remote of stream){
          if(!remote.id||!remote.status)throw new CommerceError('invalid_agent_response','Runtime returned an invalid Task');
          this.store.recordRemoteTask(order.id,service.execution.cardUrl,remote.id,remote.contextId,this.options.execute.remoteInterface?.(remote));
          if(continued)this.store.acceptContinuation(continued.continuation.id);
          await this.store.save(this.project(remote,original,order),context);this.wake(order.taskId);
          if(TERMINAL.includes(remote.status.state)||WAITING.includes(remote.status.state)){observed=true;break;}
        }
        if(!observed){this.store.markExecutionUnknown(order.id);this.wake(order.taskId);}
      }catch(error){
        if(continued)this.store.unknownContinuation(continued.continuation.id);
        this.store.markExecutionUnknown(order.id);this.options.onError?.(error instanceof CommerceError?error.code:'execution_unknown',order.id);this.wake(order.taskId);
      }finally{this.activeOrders.delete(order.id);}
    }
  }
  async waitForTask(taskId:string,context:ServerCallContext):Promise<Task>{
    for(;;){
      const task=await this.store.load(taskId,context);
      if(!task)throw new TaskNotFoundError('Task not found');
      if(task.metadata?.recoveryRequired)throw new CommerceError('execution_unknown',`Execution requires reconciliation; retrieve original Task ${taskId}`);
      if(TERMINAL.includes(task.status?.state??0)||WAITING.includes(task.status?.state??0))return task;
      if(this.stopped)throw new CommerceError('server_draining','Retrieve the original Task after restart');
      await new Promise<void>((resolve,reject)=>{
        const callbacks=this.waiters.get(taskId)??new Set();
        const done=()=>{clearTimeout(timer);callbacks.delete(done);resolve();};
        const timer=setTimeout(()=>{callbacks.delete(done);reject(new CommerceError('execution_pending','Use GetTask with the original Task ID'));},30000);
        callbacks.add(done);this.waiters.set(taskId,callbacks);
      });
    }
  }
  private wake(taskId:string):void {for(const callback of this.waiters.get(taskId)??[])callback();this.waiters.delete(taskId);}
  stop():void {this.stopped=true;for(const id of this.waiters.keys())this.wake(id);}
  get isRunning():boolean {return this.running||this.recoveries.size>0;}
}
