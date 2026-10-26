import { SendMessageRequest, TaskState, Task } from '@a2a-js/sdk';
import type { Work } from '../connector/contracts.generated.js';
import { NativeRequestNotStarted, NativeA2AClient, type NativeA2ASettings, type NativeTaskReference } from './native-a2a.js';
import { RuntimeOutcomeUnknown, type RuntimeAdapter, type RuntimeObservation, type RuntimeReadiness, type RuntimeReference } from './types.js';

export class RuntimeControlUnsupported extends Error {
  constructor() { super('The native runtime cannot confirm this control operation. Keep observing the original task.'); }
}
export class A2ARuntimeAdapter implements RuntimeAdapter {
  private readonly client: NativeA2AClient;
  constructor(readonly key: string, private readonly settings: NativeA2ASettings) { this.client = new NativeA2AClient(settings); }
  async probe(): Promise<RuntimeReadiness> {
    const card = await this.client.probe();
    // The currently supported native plugins retain tasks in memory. Their restart loses those handles.
    return { adapter: this.key, runtimeVersion: card.version || 'unknown', capabilities: { recover: true, input: false, cancel: false } };
  }
  private reference(reference: RuntimeReference): NativeTaskReference {
    if (reference.adapter !== this.key || reference.version !== 1 || !reference.value ||
        Object.keys(reference.value).sort().join(',') !== 'contextId,interfaceUrl,origin,taskId')
      throw new RuntimeOutcomeUnknown('native_reference_mismatch');
    const value = reference.value;
    if (Object.values(value).some(item => typeof item !== 'string' || item.length > 2048) || value.origin !== this.settings.cardUrl)
      throw new RuntimeOutcomeUnknown('native_reference_mismatch');
    return value as unknown as NativeTaskReference;
  }
  private observed(task: Task, reference: NativeTaskReference): RuntimeObservation {
    const wire = Task.toJSON(task) as { artifacts?: { parts?: unknown }[]; status?: { message?: { parts?: unknown } } };
    const textParts = (parts: unknown): string[] => Array.isArray(parts)
      ? parts.flatMap(part => part && typeof part === 'object' && typeof part.text === 'string' ? [part.text] : []) : [];
    const artifacts = (wire.artifacts ?? []).flatMap(artifact => textParts(artifact.parts));
    const text = (artifacts.length ? artifacts : textParts(wire.status?.message?.parts)).join('\n');
    const state: RuntimeObservation['state'] = ({
      [TaskState.TASK_STATE_COMPLETED]: 'completed', [TaskState.TASK_STATE_FAILED]: 'failed',
      [TaskState.TASK_STATE_REJECTED]: 'failed', [TaskState.TASK_STATE_CANCELED]: 'canceled',
      [TaskState.TASK_STATE_INPUT_REQUIRED]: 'input_required', [TaskState.TASK_STATE_AUTH_REQUIRED]: 'input_required',
    } as Record<number, RuntimeObservation['state']>)[task.status?.state ?? 0] ?? 'working';
    const result: RuntimeObservation = { reference: { adapter: this.key, version: 1, value: { ...reference } }, state };
    if (Buffer.byteLength(text) > 32000) return { ...result, state: 'failed', errorCode: 'result_too_large', text: 'The original native result exceeds this text service limit. Inspect the original Task; do not repeat it.' };
    if (state === 'completed' && !text.trim()) return { ...result, state: 'failed', errorCode: 'empty_native_result', text: 'The native Task completed without a text result.' };
    return { ...result, ...(text ? { text } : {}) };
  }
  async start(work: Work, executionKey: string): Promise<RuntimeObservation> {
    if (executionKey !== work.id) throw new Error('Use the original Envar work ID as execution key');
    try {
      const result = await this.client.send(SendMessageRequest.fromJSON({
        message: { messageId: work.id, contextId: 'envar-' + work.context_id, role: 'ROLE_USER', parts: [{ text: work.request.message }] },
        configuration: { returnImmediately: true },
      }));
      return this.observed(result.task, result.reference);
    } catch (error) { if (error instanceof NativeRequestNotStarted) throw error; throw new RuntimeOutcomeUnknown('native_dispatch_unknown'); }
  }
  async observe(reference: RuntimeReference): Promise<RuntimeObservation> {
    const remote = this.reference(reference);
    try { const result = await this.client.read(remote); return this.observed(result.task, result.reference); }
    catch { throw new RuntimeOutcomeUnknown('native_task_unavailable'); }
  }
  async provideInput(_reference: RuntimeReference, _operationId: string, _text: string): Promise<RuntimeObservation> {
    throw new RuntimeControlUnsupported();
  }
  async cancel(_reference: RuntimeReference, _operationId: string): Promise<RuntimeObservation> {
    // OpenClaw explicitly refuses CancelTask. Hermes does not expose proven native-run abort evidence.
    throw new RuntimeControlUnsupported();
  }
  async close(): Promise<void> { /* Runtime lifecycle remains with its owner. */ }
}
