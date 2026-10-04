import { AgentCard, GetTaskRequest, Role, SendMessageRequest, Task, TaskState, type StreamResponse, type ListTasksRequest } from '@a2a-js/sdk';
import { DefaultRequestHandler, InMemoryTaskStore, JsonRpcTransportHandler, ServerCallContext } from '@a2a-js/sdk/server';
import { RequestMalformedError, TaskNotFoundError, UnsupportedOperationError } from '@a2a-js/sdk/errors';
import { setTimeout as sleep } from 'node:timers/promises';
import { CommerceBuyer, type BuyerSnapshot } from './buyer.js';
import { CommerceError, type Input } from './types.js';
import { validateUrl } from './config.js';

export interface PeerProxyOptions {
  buyer: CommerceBuyer;
  /** Exact configured local peer ID and offer; incoming requests cannot choose a target. */
  peerId: string; offerId: string;
  origin: string; name: string;
  /** Stable namespace. Owner management credentials must use namespace:principal for review. */
  callerNamespace: string;
  authenticate: (request: Request) => Promise<string | null>;
  /** Explicitly map native text calls to one service input field, e.g. "request". */
  textInputField?: string;
  /** Native Hermes waits for text; OpenClaw returns immediately. Bounded and never retries payment. */
  waitMs?: number;
}
const disabled = () => { throw new UnsupportedOperationError('This peer proxy supports SendMessage and GetTask only'); };
class PeerHandler extends DefaultRequestHandler {
  constructor(private proxy: PeerProxy, card: AgentCard) {
    super(card, new InMemoryTaskStore(), { execute: async () => disabled(), cancelTask: async () => disabled() });
  }
  override sendMessage(params: SendMessageRequest, context: ServerCallContext): Promise<Task> { return this.proxy.send(params, context); }
  override getTask(params: GetTaskRequest, context: ServerCallContext): Promise<Task> { return this.proxy.get(params, context); }
  override async listTasks(_params: ListTasksRequest, _context: ServerCallContext) { return disabled(); }
  override async *sendMessageStream(): AsyncGenerator<StreamResponse> { disabled(); }
  override async *resubscribe(): AsyncGenerator<StreamResponse> { disabled(); }
}

/** Private, pre-bound A2A entry to an existing buyer. No arbitrary-target wallet proxy. */
export class PeerProxy {
  private readonly card: AgentCard;
  private readonly transport: JsonRpcTransportHandler;
  private readonly cardUrl: string;
  readonly origin: string;
  private stopped = false;
  constructor(private readonly options: PeerProxyOptions) {
    const origin = validateUrl(options.origin, true);
    if (origin.pathname !== '/' || origin.search || (!['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) && origin.protocol !== 'https:')) throw new CommerceError('proxy_origin', 'Peer proxy must use loopback or an explicit HTTPS origin');
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(options.callerNamespace) || !options.name || !options.offerId) throw new CommerceError('proxy_configuration', 'Stable proxy namespace, name and offer are required');
    if (options.textInputField && (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(options.textInputField) || ['constructor', 'prototype', '__proto__'].includes(options.textInputField))) throw new CommerceError('proxy_input_mapping', 'Text input field must be an explicit safe property name');
    if (options.waitMs !== undefined && (!Number.isInteger(options.waitMs) || options.waitMs < 0 || options.waitMs > 25000)) throw new CommerceError('proxy_wait', 'Proxy observation wait must be 0–25000ms');
    const peers = options.buyer.policy.peers.filter(peer => peer.id === options.peerId);
    if (peers.length !== 1) throw new CommerceError('peer_not_allowed', 'Select one locally configured buyer peer');
    this.cardUrl = peers[0]!.cardUrl;
    this.origin = origin.origin;
    this.card = AgentCard.fromJSON({
      name: options.name, description: 'A private, locally approved service peer. Purchases follow the wallet owner policy.', version: '1',
      supportedInterfaces: [{ url: `${this.origin}/a2a`, protocolVersion: '1.0', protocolBinding: 'JSONRPC' }],
      capabilities: { streaming: false, pushNotifications: false }, defaultInputModes: ['application/json', ...(options.textInputField ? ['text/plain'] : [])], defaultOutputModes: ['text/plain', 'application/json'],
      skills: [{ id: options.offerId, name: options.name, description: 'Send one request to the configured service. Keep the original Task ID on uncertainty.', tags: ['service'] }],
      securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: 'bearer' } } }, securityRequirements: [{ schemes: { bearer: { list: [] } } }],
    });
    this.transport = new JsonRpcTransportHandler(new PeerHandler(this, this.card));
  }
  stop(): void { this.stopped = true; }
  private caller(context: ServerCallContext): string {
    if (!context.user?.isAuthenticated || !context.user.userName || context.user.userName.length > 150 || context.tenant) throw new RequestMalformedError('Authenticated local proxy identity required');
    return `${this.options.callerNamespace}:${context.user.userName}`;
  }
  private input(params: SendMessageRequest): Input {
    const message = params.message;
    if (!message || message.role !== Role.ROLE_USER || !message.messageId || message.messageId.length > 128 || message.parts.length !== 1 || message.referenceTaskIds.length || message.metadata || params.metadata || params.configuration?.taskPushNotificationConfig) throw new RequestMalformedError('Send one user text or data part with a stable messageId');
    const part = message.parts[0]!.content;
    if (part?.$case === 'data' && part.value && typeof part.value === 'object' && !Array.isArray(part.value)) return part.value as Input;
    if (part?.$case === 'text' && this.options.textInputField && part.value.trim()) return { [this.options.textInputField]: part.value };
    throw new RequestMalformedError('Message must match the locally configured service input mapping');
  }
  private project(snapshot: BuyerSnapshot): Task {
    let state: TaskState;
    let statusText: string | undefined;
    if (snapshot.state === 'previewed') {
      state = TaskState.TASK_STATE_AUTH_REQUIRED;
      statusText = `Owner approval required for purchase ${snapshot.id}. Review it through the private wallet management interface. Keep this Task ID; do not create a replacement request.`;
    } else if (snapshot.state === 'unknown' || snapshot.paymentState === 'unknown') {
      state = TaskState.TASK_STATE_AUTH_REQUIRED;
      statusText = `Purchase ${snapshot.id} requires owner reconciliation. Keep this Task ID and original message ID; do not create a replacement purchase.`;
    } else if (snapshot.executionState === 'completed') state = TaskState.TASK_STATE_COMPLETED;
    else if (snapshot.executionState === 'failed' || snapshot.state === 'failed' || snapshot.paymentState === 'rejected') state = TaskState.TASK_STATE_FAILED;
    else if (snapshot.executionState === 'input_required') state = TaskState.TASK_STATE_INPUT_REQUIRED;
    else if (snapshot.executionState === 'auth_required') state = TaskState.TASK_STATE_AUTH_REQUIRED;
    else state = TaskState.TASK_STATE_WORKING;
    const remote = snapshot.task;
    return Task.fromJSON({
      ...(remote ?? {}), id: snapshot.id, contextId: `purchase-${snapshot.id}`,
      status: { state: TaskState[state], timestamp: snapshot.updatedAt, ...(statusText ? { message: { messageId: `status-${snapshot.id}`, role: 'ROLE_AGENT', parts: [{ text: statusText }] } } : remote?.status && typeof remote.status === 'object' && 'message' in remote.status ? { message: remote.status.message } : {}) },
      metadata: { purchaseId: snapshot.id, paymentState: snapshot.paymentState, executionState: snapshot.executionState, ownerActionRequired: snapshot.state === 'previewed' || snapshot.state === 'unknown' || snapshot.paymentState === 'unknown' },
    });
  }
  private assertBoundPeer(): void {
    const peer = this.options.buyer.policy.peers.find(peer => peer.id === this.options.peerId);
    if (!peer || peer.cardUrl !== this.cardUrl) throw new CommerceError('policy_changed', 'Proxy peer binding changed; recreate the proxy after local review');
  }
  async send(params: SendMessageRequest, context: ServerCallContext): Promise<Task> {
    if (this.stopped) throw new CommerceError('proxy_stopped', 'Peer proxy is stopping');
    this.assertBoundPeer();
    const caller = this.caller(context), input = this.input(params), message = params.message!;
    let snapshot: BuyerSnapshot;
    if (message.taskId) snapshot = await this.options.buyer.continue(caller, message.taskId, { messageId: message.messageId, input });
    else {
      snapshot = await this.options.buyer.preview(caller, { cardUrl: this.cardUrl, offerId: this.options.offerId, messageId: message.messageId, input });
      // A model-produced message never substitutes for owner confirmation.
      if (snapshot.state === 'previewed' && this.options.buyer.policy.approval === 'within_preapproved_limits') snapshot = await this.options.buyer.confirm(caller, { previewId: snapshot.id, quoteToken: snapshot.quoteToken, messageId: snapshot.messageId });
    }
    if (!params.configuration?.returnImmediately && this.options.waitMs !== 0) {
      const deadline = Date.now() + (this.options.waitMs ?? 20000);
      while (!this.stopped && snapshot.state === 'submitted' && ['working', 'queued', 'not_started'].includes(snapshot.executionState) && Date.now() < deadline) {
        await sleep(100); snapshot = this.options.buyer.get(caller, snapshot.id);
      }
    }
    return this.project(snapshot);
  }
  async get(params: GetTaskRequest, context: ServerCallContext): Promise<Task> {
    try { return this.project(this.options.buyer.get(this.caller(context), params.id)); }
    catch (error) { if (error instanceof CommerceError && error.code === 'purchase_not_found') throw new TaskNotFoundError('Task not found for this proxy caller'); throw error; }
  }
  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url), headers = { 'Cache-Control': 'no-store', 'A2A-Version': '1.0' };
    if (url.origin !== this.origin || (request.headers.get('Host') && request.headers.get('Host') !== url.host)) return Response.json({ error: 'invalid_host' }, { status: 421, headers });
    if (url.search || (request.headers.get('Origin') && request.headers.get('Origin') !== this.origin)) return Response.json({ error: 'request_scope' }, { status: 403, headers });
    if (request.method === 'GET' && url.pathname === '/.well-known/agent-card.json') return Response.json(AgentCard.toJSON(this.card), { headers });
    if (request.method !== 'POST' || url.pathname !== '/a2a') return Response.json({ error: 'not_found' }, { status: 404, headers });
    if (this.stopped) return Response.json({ error: 'unavailable' }, { status: 503, headers });
    const caller = await this.options.authenticate(request);
    if (!caller) return Response.json({ error: 'authentication_required' }, { status: 401, headers: { ...headers, 'WWW-Authenticate': 'Bearer' } });
    if (request.headers.has('PAYMENT-SIGNATURE') || request.headers.has('Payment-Authorization')) return Response.json({ error: 'agent_credentials_not_accepted' }, { status: 400, headers });
    // OpenClaw's installed native A2A channel omits this optional HTTP header.
    if (request.headers.has('A2A-Version') && request.headers.get('A2A-Version') !== '1.0') return Response.json({ error: 'unsupported_version' }, { status: 400, headers });
    let length = 0; const chunks: Uint8Array[] = [];
    if (request.body) {
      const reader = request.body.getReader();
      for (;;) { const next = await reader.read(); if (next.done) break; length += next.value.byteLength; if (length > 1024 * 1024) { await reader.cancel(); return Response.json({ error: 'request_too_large' }, { status: 413, headers }); } chunks.push(next.value); }
    }
    let rpcId: unknown = null;
    try {
      const body = Buffer.concat(chunks).toString('utf8');
      const raw = JSON.parse(body) as Record<string, unknown>;
      if (!raw || Array.isArray(raw) || raw.jsonrpc !== '2.0' || !['string', 'number'].includes(typeof raw.id)) throw new RequestMalformedError('One A2A JSONRPC request is required');
      rpcId = raw.id;
      if (!['SendMessage', 'GetTask'].includes(String(raw.method))) throw new UnsupportedOperationError('Use SendMessage or GetTask');
      const result = await this.transport.handle(body, new ServerCallContext({ user: { isAuthenticated: true, userName: caller }, requestedVersion: '1.0' }));
      if (Symbol.asyncIterator in result) throw new UnsupportedOperationError('Streaming is unavailable');
      return Response.json(result, { headers });
    } catch (error) {
      const mapped = error instanceof CommerceError ? { code: -32000, message: error.code } : JsonRpcTransportHandler.mapToJSONRPCError(error);
      return Response.json({ jsonrpc: '2.0', id: rpcId, error: mapped }, { headers });
    }
  }
}
