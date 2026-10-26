/** Shared official A2A transport for local runtime adapters and the legacy seller gate. */
import { randomUUID } from 'node:crypto';
import { AgentCard, GetTaskRequest, SendMessageRequest, Task } from '@a2a-js/sdk';
import { TaskNotFoundError, RequestMalformedError } from '@a2a-js/sdk/errors';
import { ClientFactory, JsonRpcTransportFactory } from '@a2a-js/sdk/client';
import { validateUrl } from '../commerce/config.js';
import { CommerceError } from '../commerce/types.js';

export class NativeRequestNotStarted extends Error {
  constructor() { super('Native A2A rejected the request before starting a task. Check the peer configuration, gateway address and protocol version.'); }
}
export interface NativeTaskReference { origin: string; interfaceUrl: string; taskId: string; contextId: string; }
type RecoverableReference = Omit<NativeTaskReference, "interfaceUrl"> & { interfaceUrl?: string };
export interface NativeA2ASettings { cardUrl: string; token: string; fetch?: typeof fetch; signal?: AbortSignal; }
export class NativeA2AClient {
  private readonly cardUrl: URL;
  constructor(private readonly settings: NativeA2ASettings) {
    this.cardUrl = validateUrl(settings.cardUrl, true);
    if (!settings.token || settings.token.length < 16 || /[\r\n]/.test(settings.token))
      throw new CommerceError('upstream_credentials', 'Configure a private native peer credential');
  }
  private async prepare(remote?: RecoverableReference) {
    if (remote && (remote.origin !== this.settings.cardUrl || !remote.taskId))
      throw new CommerceError('upstream_origin', 'Recover only the original configured runtime');
    const scopedFetch: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).origin !== this.cardUrl.origin)
        throw new CommerceError('upstream_origin', 'Native interfaces must share the configured Card origin');
      const headers = new Headers(request.headers);
      headers.set('Authorization', 'Bearer ' + this.settings.token); headers.set('A2A-Version', '1.0');
      const signals = [request.signal, AbortSignal.timeout(120000), ...(this.settings.signal ? [this.settings.signal] : [])];
      const response = await (this.settings.fetch ?? fetch)(new Request(request, {
        headers, redirect: 'error', signal: AbortSignal.any(signals),
      }));
      if ([400, 401, 403, 404, 405, 415].includes(response.status)) throw new NativeRequestNotStarted();
      if (Number(response.headers.get('Content-Length') ?? 0) > 4 * 1024 * 1024)
        throw new CommerceError('upstream_size', 'Native response exceeds the limit');
      if (!response.body) return response;
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
      for (;;) {
        const next = await reader.read(); if (next.done) break;
        size += next.value.byteLength;
        if (size > 4 * 1024 * 1024) { await reader.cancel(); throw new CommerceError('upstream_size', 'Native response exceeds the limit'); }
        chunks.push(next.value);
      }
      return new Response(Buffer.concat(chunks), { status: response.status, statusText: response.statusText, headers: response.headers });
    };
    const response = await scopedFetch(this.cardUrl);
    if (!response.ok) throw new CommerceError('upstream_card', 'Unable to read the native Agent Card');
    const card = AgentCard.fromJSON(await response.json());
    const selected = card.supportedInterfaces.find(item => item.protocolVersion === '1.0' && item.protocolBinding === 'JSONRPC');
    if (!selected) throw new CommerceError('upstream_version', 'Native runtime must expose A2A 1.0 JSONRPC');
    if (card.supportedInterfaces.some(item => validateUrl(item.url, true).origin !== this.cardUrl.origin))
      throw new CommerceError('upstream_origin', 'Native interfaces must share the configured Card origin');
    if (remote?.interfaceUrl && remote.interfaceUrl !== selected.url)
      throw new CommerceError('upstream_endpoint_changed', 'Original Task interface changed; restore it before recovery');
    const client = await new ClientFactory({ transports: [new JsonRpcTransportFactory({ fetchImpl: scopedFetch })] })
      .createFromAgentCard({ ...card, supportedInterfaces: [selected] });
    return { card, client, interfaceUrl: selected.url };
  }
  async probe(): Promise<AgentCard> {
    const prepared = await this.prepare();
    try {
      await prepared.client.getTask(GetTaskRequest.fromJSON({ id: 'envar-connection-probe-' + randomUUID() }));
    } catch (error) {
      if (error instanceof TaskNotFoundError) return prepared.card;
      throw new CommerceError('upstream_probe', 'Native A2A check failed. Check the gateway address, dedicated peer authorization and restart status.');
    }
    throw new CommerceError('upstream_probe', 'Native runtime returned an unexpected probe Task');
  }
  private observed(value: unknown, interfaceUrl: string, expected?: string): { task: Task; reference: NativeTaskReference } {
    if (!value || typeof value !== 'object' || !('status' in value) || !('id' in value) || typeof value.id !== 'string' || !value.id)
      throw new CommerceError('upstream_task_required', 'Native runtime returned no original Task handle');
    const task = value as Task;
    if (expected && task.id !== expected) throw new CommerceError('remote_task_conflict', 'Native runtime returned another Task');
    return { task, reference: { origin: this.settings.cardUrl, interfaceUrl, taskId: task.id, contextId: task.contextId ?? '' } };
  }
  async send(request: SendMessageRequest, remote?: RecoverableReference) {
    let prepared;
    try { prepared = await this.prepare(remote); } catch { throw new NativeRequestNotStarted(); }
    // Exactly one native POST. A lost response must not cause a replacement task.
    try { return this.observed(await prepared.client.sendMessage(request), prepared.interfaceUrl, remote?.taskId); }
    catch (error) { if (error instanceof RequestMalformedError) throw new NativeRequestNotStarted(); throw error; }
  }
  async read(remote: RecoverableReference) {
    const prepared = await this.prepare(remote);
    return this.observed(await prepared.client.getTask(GetTaskRequest.fromJSON({ id: remote.taskId })), prepared.interfaceUrl, remote.taskId);
  }
}
