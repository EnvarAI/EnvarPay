import { timingSafeEqual } from 'node:crypto';
import { AgentCard, GetTaskRequest, Role, Task, TaskState, type SendMessageRequest, type StreamResponse } from '@a2a-js/sdk';
import { DefaultRequestHandler, JsonRpcTransportHandler, ServerCallContext, type AgentExecutor } from '@a2a-js/sdk/server';
import { RequestMalformedError, TaskNotFoundError, UnsupportedOperationError } from '@a2a-js/sdk/errors';
import { createOfferCard, offerPath } from './card.js';
import { digest, loadCommerceConfig } from './config.js';
import { buildQuote } from './pricing.js';
import { CommerceStore, type OrderRecord } from './store.js';
import { CommerceError, type CommerceConfig, type Input, type Service } from './types.js';

export type ExecuteOrder = (order:OrderRecord,service:Service) => AsyncIterable<Task>;
export interface CommerceServerOptions {
  config: CommerceConfig;
  origin: string;
  store: CommerceStore;
  authenticate: (request:Request)=>Promise<string|null>;
  execute: ExecuteOrder;
  onError?: (code:string,orderId?:string)=>void;
}
const TERMINAL=[TaskState.TASK_STATE_COMPLETED,TaskState.TASK_STATE_FAILED,TaskState.TASK_STATE_CANCELED,TaskState.TASK_STATE_REJECTED];

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
  if(!m||m.role!==Role.ROLE_USER||!m.messageId||m.messageId.length>128||m.parts.length!==1||m.taskId||m.contextId||m.referenceTaskIds.length) throw new RequestMalformedError('New commerce orders require one user data part and a stable messageId');
  const p=m.parts[0]!.content;
  if(p?.$case!=='data'||!p.value||typeof p.value!=='object'||Array.isArray(p.value))throw new RequestMalformedError('Provide the service JSON input in one data part');
  return p.value as Input;
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
    const prior=this.host.store.findOrder(caller,`${this.service.id}:${this.service.revision}`,params.message!.messageId);
    if(prior){
      if(prior.inputDigest!==digest(input)||prior.offerId!==this.offerId)throw new RequestMalformedError('Message ID already identifies a different purchase');
      const original=await this.host.store.load(prior.taskId,context);
      if(original)return original;
    }
    if(!this.active)throw new UnsupportedOperationError('This service revision is retired; existing Tasks remain readable');
    const quote=buildQuote(this.host.config,{serviceId:this.service.id,offerId:this.offerId,caller,messageId:params.message!.messageId,input});
    const order=this.host.store.ensureQuote(quote,input);
    if(order.paymentState!=='not_required')throw new UnsupportedOperationError('Payment transport must be enabled before this paid offer can execute');
    const task=this.host.store.enqueueFree(order.id,caller);
    this.host.schedule();
    if(params.configuration?.returnImmediately===true)return task;
    return this.host.waitForTask(order.taskId,context);
  }
  override async getTask(params:GetTaskRequest,context:ServerCallContext):Promise<Task>{
    const task=await this.host.store.load(params.id,context);
    if(!task)throw new TaskNotFoundError('Task not found');
    if(params.historyLength!==undefined){if(params.historyLength<0)throw new RequestMalformedError('historyLength must be nonnegative');task.history=params.historyLength===0?[]:task.history.slice(-params.historyLength);}
    return task;
  }
  override async *sendMessageStream():AsyncGenerator<StreamResponse> {throw new UnsupportedOperationError('Streaming is not available on this commerce entry');}
  override async *resubscribe():AsyncGenerator<StreamResponse> {throw new UnsupportedOperationError('Task subscriptions are not available on this commerce entry');}
}

/** HTTP handler + one durable worker. It never changes caller identity from payload. */
export class CommerceServer {
  readonly config:CommerceConfig;
  readonly store:CommerceStore;
  private readonly routes=new Map<string,{card:AgentCard;rpc:JsonRpcTransportHandler;tenant:string}>();
  private running=false;
  private kickPending=false;
  private stopped=false;
  private waiters=new Map<string,Set<()=>void>>();
  constructor(private options:CommerceServerOptions){
    this.config=loadCommerceConfig(options.config);this.store=options.store;
    this.store.registerCatalog(this.config);
    for(const entry of this.store.catalogHistory())for(const offer of entry.service.offers){
      const service=entry.service;
      const historical={...this.config,paymentProfiles:entry.profiles,services:[service]};
      const card=createOfferCard(historical,service.id,offer.id,options.origin);
      const active=this.config.services.some(s=>s.id===service.id&&s.revision===service.revision);
      this.routes.set(offerPath(service.id,service.revision,offer.id),{card,rpc:new JsonRpcTransportHandler(new OrderHandler(this,service,offer.id,card,this.store,active)),tenant:`${service.id}:${service.revision}`});
    }
    // Single instance has exclusive ownership of its store for the process lifetime.
    this.store.recoverInterruptedDispatches();
    this.schedule();
  }
  private context(caller:string,tenant:string):ServerCallContext {
    return new ServerCallContext({user:{isAuthenticated:true,userName:caller},tenant,requestedVersion:'1.0'});
  }
  async handle(request:Request):Promise<Response>{
    const url=new URL(request.url);
    if(url.origin!==new URL(this.options.origin).origin)return Response.json({error:'invalid_host'},{status:421});
    const base=url.pathname.replace(/\/(agent-card\.json|a2a)$/,'');
    const route=this.routes.get(base);
    if(!route)return Response.json({error:'not_found'},{status:404});
    if(request.method==='GET'&&url.pathname.endsWith('/agent-card.json'))return Response.json(AgentCard.toJSON(route.card),{headers:{'Cache-Control':'public, max-age=60'}});
    if(request.method!=='POST'||!url.pathname.endsWith('/a2a'))return Response.json({error:'method_not_allowed'},{status:405});
    const caller=await this.options.authenticate(request);
    if(!caller)return Response.json({error:'authentication_required'},{status:401,headers:{'WWW-Authenticate':'Bearer','Cache-Control':'no-store'}});
    if(request.headers.get('A2A-Version')!=='1.0')return Response.json({error:'A2A-Version 1.0 required'},{status:400});
    if(Number(request.headers.get('Content-Length')??0)>1024*1024)return Response.json({error:'request_too_large'},{status:413});
    let size=0;const chunks:Uint8Array[]=[];
    if(request.body){const reader=request.body.getReader();while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>1024*1024){await reader.cancel();return Response.json({error:'request_too_large'},{status:413});}chunks.push(value);}}
    const body=Buffer.concat(chunks).toString('utf8');
    try{
      const raw=JSON.parse(body) as Record<string,unknown>;
      const params=raw.params;
      if(params&&typeof params==='object'&&'tenant' in params&&params.tenant!==route.tenant)return Response.json({jsonrpc:'2.0',id:raw.id??null,error:{code:-32602,message:'Invalid tenant'}},{status:200});
      const result=await route.rpc.handle(body,this.context(caller,route.tenant));
      if(Symbol.asyncIterator in result)return Response.json({jsonrpc:'2.0',id:raw.id??null,error:{code:-32004,message:'Streaming not available'}},{status:200});
      return Response.json(result,{headers:{'A2A-Version':'1.0','Cache-Control':'no-store'}});
    }catch(error){
      const mapped=JsonRpcTransportHandler.mapToJSONRPCError(error);
      return Response.json({jsonrpc:'2.0',id:null,error:mapped},{headers:{'Cache-Control':'no-store'}});
    }
  }
  schedule():void {
    if(this.stopped)return;
    if(this.running){this.kickPending=true;return;}
    this.running=true;
    void this.drain().catch(()=>this.options.onError?.('worker_failure')).finally(()=>{this.running=false;if(this.kickPending){this.kickPending=false;this.schedule();}});
  }
  private async drain():Promise<void>{
    while(!this.stopped){
      const order=this.store.claimReady();if(!order)return;
      const service=this.store.serviceRevision(order.serviceRevision);
      if(!service){this.store.markExecutionUnknown(order.id);this.wake(order.taskId);continue;}
      const context=this.context(order.caller,order.serviceRevision);
      const original=await this.store.load(order.taskId,context);
      if(!original){this.store.markExecutionUnknown(order.id);this.wake(order.taskId);continue;}
      try{
        let terminal=false;
        for await(const remote of this.options.execute(order,service)){
          if(!remote.id||!remote.status)throw new CommerceError('invalid_agent_response','Runtime returned an invalid Task');
          this.store.recordRemoteTask(order.id,service.execution.cardUrl,remote.id);
          const projected=Task.fromJSON({...Task.toJSON(remote) as Record<string,unknown>,id:order.taskId,contextId:original.contextId});
          await this.store.save(projected,context);this.wake(order.taskId);
          if(TERMINAL.includes(remote.status.state)){terminal=true;break;}
        }
        if(!terminal){this.store.markExecutionUnknown(order.id);this.wake(order.taskId);}
      }catch(error){this.store.markExecutionUnknown(order.id);this.options.onError?.(error instanceof CommerceError?error.code:'execution_unknown',order.id);this.wake(order.taskId);}
    }
  }
  async waitForTask(taskId:string,context:ServerCallContext):Promise<Task>{
    for(;;){
      const task=await this.store.load(taskId,context);
      if(!task)throw new TaskNotFoundError('Task not found');
      if(task.metadata?.recoveryRequired)throw new CommerceError('execution_unknown',`Execution requires reconciliation; retrieve original Task ${taskId}`);
      if(TERMINAL.includes(task.status?.state??0)||[TaskState.TASK_STATE_INPUT_REQUIRED,TaskState.TASK_STATE_AUTH_REQUIRED].includes(task.status?.state??0))return task;
      await new Promise<void>((resolve,reject)=>{
        const callbacks=this.waiters.get(taskId)??new Set();
        const done=()=>{clearTimeout(timer);callbacks.delete(done);resolve();};
        const timer=setTimeout(()=>{callbacks.delete(done);reject(new CommerceError('execution_pending','Use GetTask with the original Task ID'));},30000);
        callbacks.add(done);this.waiters.set(taskId,callbacks);
      });
    }
  }
  private wake(taskId:string):void {for(const callback of this.waiters.get(taskId)??[])callback();this.waiters.delete(taskId);}
  stop():void {this.stopped=true;}
  get isRunning():boolean {return this.running;}
}
