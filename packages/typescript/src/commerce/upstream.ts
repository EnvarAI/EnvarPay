import { AgentCard, GetTaskRequest, SendMessageRequest, Task, TaskState } from '@a2a-js/sdk';
import { ClientFactory, JsonRpcTransportFactory } from '@a2a-js/sdk/client';
import { setTimeout as sleep } from 'node:timers/promises';
import { CommerceError, type Input, type Service } from './types.js';
import type { ExecuteOrder } from './server.js';
import type { RemoteTaskReference } from './store.js';
import { validateUrl } from './config.js';

/** Official A2A calls, pinned to the configured origin and original remote interface. */
export interface NativeA2AOptions { inputEncoding?:Readonly<Record<string,'data'|'json-text'>>; }
export function nativeA2AExecutor(tokens:Readonly<Record<string,string>>,fetchImpl:typeof fetch=fetch,signal?:AbortSignal,options:NativeA2AOptions={}):ExecuteOrder {
  const inputEncoding=Object.freeze({...options.inputEncoding});
  if(Object.values(inputEncoding).some(value=>value!=='data'&&value!=='json-text'))throw new CommerceError('invalid_upstream_encoding','Choose an explicit data or json-text input encoding');
  const parts=(service:Service,input:Input)=>inputEncoding[service.id]==='json-text'?[{text:JSON.stringify(input),mediaType:'application/json'}]:[{data:input}];
  const interfaces=new WeakMap<Task,string>();
  async function prepare(service:Service,remote?:RemoteTaskReference){
    const cardUrl=validateUrl(service.execution.cardUrl,true),token=tokens[`${service.id}:${service.revision}`]??tokens[service.id];
    if(!token||token.length<16)throw new CommerceError('upstream_credentials','Configured runtime authentication is missing');
    if(remote&&remote.origin!==service.execution.cardUrl)throw new CommerceError('upstream_origin','Original runtime origin differs from the frozen service');
    const scopedFetch:typeof fetch=async(input,init)=>{
      const request=new Request(input,init);
      if(new URL(request.url).origin!==cardUrl.origin)throw new CommerceError('upstream_origin','Runtime Card cannot redirect credentials to another origin');
      const headers=new Headers(request.headers);headers.set('Authorization','Bearer '+token);headers.set('A2A-Version','1.0');
      const signals=[request.signal,AbortSignal.timeout(120000),...(signal?[signal]:[])];
      const response=await fetchImpl(new Request(request,{headers,redirect:'error',signal:AbortSignal.any(signals)}));
      if(Number(response.headers.get('Content-Length')??0)>4*1024*1024)throw new CommerceError('upstream_size','Runtime response exceeds limit');
      if(response.body){
        const reader=response.body.getReader(),chunks:Uint8Array[]=[];let length=0;
        for(;;){const next=await reader.read();if(next.done)break;length+=next.value.byteLength;
          if(length>4*1024*1024){await reader.cancel();throw new CommerceError('upstream_size','Runtime response exceeds limit');}chunks.push(next.value);}
        return new Response(Buffer.concat(chunks),{status:response.status,statusText:response.statusText,headers:response.headers});
      }
      return response;
    };
    const response=await scopedFetch(cardUrl);
    if(!response.ok)throw new CommerceError('upstream_card','Unable to read runtime Agent Card');
    const card=AgentCard.fromJSON(await response.json());
    const selected=card.supportedInterfaces.find(x=>x.protocolVersion==='1.0'&&x.protocolBinding==='JSONRPC');
    if(!selected)throw new CommerceError('upstream_version','Runtime must expose A2A 1.0 JSONRPC');
    for(const endpoint of card.supportedInterfaces)if(validateUrl(endpoint.url,true).origin!==cardUrl.origin)throw new CommerceError('upstream_origin','Runtime interface must share configured Card origin');
    if(remote?.interfaceUrl&&selected.url!==remote.interfaceUrl)throw new CommerceError('upstream_endpoint_changed','Original Task interface changed; restore it before recovery');
    const factory=new ClientFactory({transports:[new JsonRpcTransportFactory({fetchImpl:scopedFetch})]});
    const client=await factory.createFromAgentCard({...card,supportedInterfaces:[selected]});
    return {client,interfaceUrl:selected.url};
  }
  type Prepared=Awaited<ReturnType<typeof prepare>>;
  function observed(task:unknown,interfaceUrl:string,expectedId?:string):Task {
    if(!task||typeof task!=='object'||!('status' in task)||!('id' in task)||!task.id)throw new CommerceError('upstream_task_required','Runtime returned no durable Task handle');
    const result=task as Task;
    if(expectedId&&result.id!==expectedId)throw new CommerceError('remote_task_conflict','Runtime returned a different Task');
    interfaces.set(result,interfaceUrl);return result;
  }
  async function* observe(task:Task,prepared:Prepared,service:Service):AsyncIterable<Task>{
    const deadline=Date.now()+service.contract.targetDurationSeconds*1000,id=task.id;
    for(;;){
      yield task;
      if([TaskState.TASK_STATE_COMPLETED,TaskState.TASK_STATE_FAILED,TaskState.TASK_STATE_CANCELED,TaskState.TASK_STATE_REJECTED,TaskState.TASK_STATE_INPUT_REQUIRED,TaskState.TASK_STATE_AUTH_REQUIRED].includes(task.status?.state??0))return;
      if(Date.now()>=deadline)throw new CommerceError('execution_pending','Read the original Task to continue observing execution');
      await sleep(1000,undefined,{signal});
      task=observed(await prepared.client.getTask(GetTaskRequest.fromJSON({id})),prepared.interfaceUrl,id);
    }
  }
  const execute:ExecuteOrder=async function*(order,service){
    const prepared=await prepare(service);
    const request=SendMessageRequest.fromJSON({message:{messageId:order.messageId,role:'ROLE_USER',parts:parts(service,order.input)},configuration:{returnImmediately:true}});
    const task=observed(await prepared.client.sendMessage(request),prepared.interfaceUrl);
    yield* observe(task,prepared,service);
  };
  execute.continue=async function*(_order,service,continuation,remote){
    const prepared=await prepare(service,remote);
    const request=SendMessageRequest.fromJSON({message:{messageId:continuation.messageId,taskId:remote.taskId,...(remote.contextId?{contextId:remote.contextId}:{}),role:'ROLE_USER',parts:parts(service,continuation.input)},configuration:{returnImmediately:true}});
    const task=observed(await prepared.client.sendMessage(request),prepared.interfaceUrl,remote.taskId);
    yield* observe(task,prepared,service);
  };
  execute.recover=async(_order,service,remote)=>{
    const prepared=await prepare(service,remote);
    // Recovery never calls SendMessage, creates a new Task, or retries a dispatch.
    return observed(await prepared.client.getTask(GetTaskRequest.fromJSON({id:remote.taskId})),prepared.interfaceUrl,remote.taskId);
  };
  execute.remoteInterface=task=>interfaces.get(task);
  return execute;
}
