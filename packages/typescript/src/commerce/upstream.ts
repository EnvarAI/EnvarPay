import { SendMessageRequest, Task, TaskState } from '@a2a-js/sdk';
import { setTimeout as sleep } from 'node:timers/promises';
import { CommerceError, type Input, type Service } from './types.js';
import type { ExecuteOrder } from './server.js';
import type { RemoteTaskReference } from './store.js';
import { NativeA2AClient, type NativeTaskReference } from '@envarai/connect/adapters/native-a2a';

/** Existing seller execution composes the same native transport as inbox connectors. */
export interface NativeA2AOptions { inputEncoding?: Readonly<Record<string, 'data' | 'json-text'>>; }
export function nativeA2AExecutor(tokens: Readonly<Record<string, string>>, fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal, options: NativeA2AOptions = {}): ExecuteOrder {
  const inputEncoding = Object.freeze({ ...options.inputEncoding });
  if (Object.values(inputEncoding).some(value => value !== 'data' && value !== 'json-text'))
    throw new CommerceError('invalid_upstream_encoding', 'Choose an explicit data or json-text input encoding');
  const parts = (service: Service, input: Input) => inputEncoding[service.id] === 'json-text'
    ? [{ text: JSON.stringify(input), mediaType: 'application/json' }] : [{ data: input }];
  const interfaces = new WeakMap<Task, string>();
  function client(service: Service) {
    return new NativeA2AClient({ cardUrl: service.execution.cardUrl,
      token: tokens[`${service.id}:${service.revision}`] ?? tokens[service.id]!, fetch: fetchImpl, signal });
  }
  function observed(result: { task: Task; reference: NativeTaskReference }) {
    interfaces.set(result.task, result.reference.interfaceUrl); return result;
  }
  async function* observe(first: { task: Task; reference: NativeTaskReference }, native: NativeA2AClient, service: Service): AsyncIterable<Task> {
    const deadline = Date.now() + service.contract.targetDurationSeconds * 1000;
    let result = first;
    for (;;) {
      yield result.task;
      if ([TaskState.TASK_STATE_COMPLETED, TaskState.TASK_STATE_FAILED, TaskState.TASK_STATE_CANCELED,
        TaskState.TASK_STATE_REJECTED, TaskState.TASK_STATE_INPUT_REQUIRED, TaskState.TASK_STATE_AUTH_REQUIRED]
        .includes(result.task.status?.state ?? 0)) return;
      if (Date.now() >= deadline) throw new CommerceError('execution_pending', 'Read the original Task to continue observing execution');
      await sleep(1000, undefined, { signal });
      result = observed(await native.read(result.reference));
    }
  }
  const execute: ExecuteOrder = async function* (order, service) {
    const native = client(service);
    const request = SendMessageRequest.fromJSON({ message: { messageId: order.messageId, role: 'ROLE_USER',
      parts: parts(service, order.input) }, configuration: { returnImmediately: true } });
    yield* observe(observed(await native.send(request)), native, service);
  };
  execute.continue = async function* (_order, service, continuation, remote) {
    const native = client(service);
    const request = SendMessageRequest.fromJSON({ message: { messageId: continuation.messageId, taskId: remote.taskId,
      ...(remote.contextId ? { contextId: remote.contextId } : {}), role: 'ROLE_USER', parts: parts(service, continuation.input) },
      configuration: { returnImmediately: true } });
    yield* observe(observed(await native.send(request, remote)), native, service);
  };
  execute.recover = async (_order, service, remote: RemoteTaskReference) => observed(await client(service).read(remote)).task;
  execute.remoteInterface = task => interfaces.get(task);
  return execute;
}
