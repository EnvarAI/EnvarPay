import { AgentCard, GetTaskRequest, SendMessageRequest, Task, TaskState } from '@a2a-js/sdk';
import { ClientFactory, JsonRpcTransportFactory } from '@a2a-js/sdk/client';
import { setTimeout as sleep } from 'node:timers/promises';
import { CommerceError } from './types.js';
import type { ExecuteOrder } from './server.js';
import { validateUrl } from './config.js';

/** Calls only the configured origin using the official A2A client. */
export function nativeA2AExecutor(tokens:Readonly<Record<string,string>>,fetchImpl:typeof fetch=fetch,signal?:AbortSignal):ExecuteOrder {
  return async function*(order,service){
    const cardUrl=validateUrl(service.execution.cardUrl,true);
    const token=tokens[service.id];
    if(!token||token.length<16)throw new CommerceError('upstream_credentials','Configured runtime authentication is missing');
    const scopedFetch:typeof fetch=async(input,init)=>{
      const request=new Request(input,init);
      if(new URL(request.url).origin!==cardUrl.origin)throw new CommerceError('upstream_origin','Runtime Card cannot redirect credentials to another origin');
      const headers=new Headers(request.headers);headers.set('Authorization','Bearer '+token);headers.set('A2A-Version','1.0');
      const signals=[request.signal,AbortSignal.timeout(120000),...(signal?[signal]:[])];
      const response=await fetchImpl(new Request(request,{headers,redirect:'error',signal:AbortSignal.any(signals)}));
      if(Number(response.headers.get('Content-Length')??0)>4*1024*1024)throw new CommerceError('upstream_size','Runtime response exceeds limit');
      // Every non-streaming body is bounded even when Content-Length is omitted.
      if(response.body){const reader=response.body.getReader();const chunks:Uint8Array[]=[];let length=0;for(;;){const next=await reader.read();if(next.done)break;length+=next.value.byteLength;if(length>4*1024*1024){await reader.cancel();throw new CommerceError('upstream_size','Runtime response exceeds limit');}chunks.push(next.value);}return new Response(Buffer.concat(chunks),{status:response.status,statusText:response.statusText,headers:response.headers});}
      return response;
    };
    const response=await scopedFetch(cardUrl);
    if(!response.ok)throw new CommerceError('upstream_card','Unable to read runtime Agent Card');
    const card=AgentCard.fromJSON(await response.json());
    if(!card.supportedInterfaces.some(x=>x.protocolVersion==='1.0'&&x.protocolBinding==='JSONRPC'))throw new CommerceError('upstream_version','Runtime must expose A2A 1.0 JSONRPC');
    for(const endpoint of card.supportedInterfaces)if(new URL(endpoint.url).origin!==cardUrl.origin)throw new CommerceError('upstream_origin','Runtime interface must share configured Card origin');
    const factory=new ClientFactory({transports:[new JsonRpcTransportFactory({fetchImpl:scopedFetch})]});
    const client=await factory.createFromAgentCard(card);
    const request=SendMessageRequest.fromJSON({message:{messageId:order.messageId,role:'ROLE_USER',parts:[{data:order.input}]},configuration:{returnImmediately:true}});
    let task=await client.sendMessage(request);
    if(!('status' in task)||!task.id)throw new CommerceError('upstream_task_required','Runtime returned no durable Task handle');
    const deadline=Date.now()+service.contract.targetDurationSeconds*1000;
    for(;;){
      yield task as Task;
      if([TaskState.TASK_STATE_COMPLETED,TaskState.TASK_STATE_FAILED,TaskState.TASK_STATE_CANCELED,TaskState.TASK_STATE_REJECTED,TaskState.TASK_STATE_INPUT_REQUIRED,TaskState.TASK_STATE_AUTH_REQUIRED].includes(task.status?.state??0))return;
      if(Date.now()>=deadline)throw new CommerceError('execution_pending','Runtime did not complete within the configured observation window');
      await sleep(1000,undefined,{signal});
      task=await client.getTask(GetTaskRequest.fromJSON({id:task.id}));
    }
  };
}
