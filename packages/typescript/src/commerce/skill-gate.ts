import { AgentCard, Task, TaskState } from '@a2a-js/sdk';
import { setTimeout as sleep } from 'node:timers/promises';
import { CommerceError, type Input, type Service } from './types.js';
import { validateUrl } from './config.js';
import type { ExecuteOrder } from './server.js';
import type { ContinuationRecord, OrderRecord, RemoteTaskReference } from './store.js';

/** The name is the service ID. The digest pins the installed skill version. */
export interface SkillDescriptor {
  name: string;
  digest: string;
  cardUrl: string;
  access: 'free' | 'paid';
  description?: string;
}

/** The Agent-owned adapter may expose one private, authenticated A2A Card per skill. */
export function createSkillCard(descriptor: SkillDescriptor, interfaceUrl: string): AgentCard {
  const card = validateUrl(descriptor.cardUrl, true), endpoint = validateUrl(interfaceUrl, true);
  if (card.origin !== endpoint.origin || !/^[a-z][a-z0-9-]{0,63}$/.test(descriptor.name) ||
      !/^[0-9a-f]{64}$/.test(descriptor.digest))
    throw new CommerceError('invalid_skill_card', 'Skill Card needs one exact named skill, pinned digest and same-origin A2A interface');
  return AgentCard.fromJSON({
    name: descriptor.name, description: `Agent Skill: ${descriptor.name}`, version: descriptor.digest,
    supportedInterfaces: [{url: endpoint.href, protocolBinding:'JSONRPC', protocolVersion:'1.0'}],
    capabilities: {streaming:false,pushNotifications:false,extensions:[{
      uri:'urn:envarpay:skill-gate:1',required:false,
      description:'The owner-operated adapter invokes this exact installed skill and gates other paid skills',
      params:{skillName:descriptor.name,skillDigest:descriptor.digest,access:descriptor.access},
    }]},
    defaultInputModes:['application/json'],defaultOutputModes:['application/json','text/plain'],
    skills:[{id:descriptor.name,name:descriptor.name,description:`Invoke ${descriptor.name}`,tags:[descriptor.name]}],
    securitySchemes:{bearer:{httpAuthSecurityScheme:{scheme:'bearer'}}},
    securityRequirements:[{schemes:{bearer:{list:[]}}}],
  });
}

/** In-process authority passed only after the seller has confirmed payment or a free offer. */
export class SkillGrant {
  readonly skillName: string;
  readonly skillDigest: string;
  readonly orderId: string;
  readonly caller: string;
  readonly messageId: string;
  readonly inputDigest: string;
  readonly #freeSkills: ReadonlySet<string>;

  constructor(order: OrderRecord, descriptor: SkillDescriptor, freeSkills: ReadonlySet<string>, messageId = order.messageId) {
    if (!['confirmed', 'not_required'].includes(order.paymentState))
      throw new CommerceError('payment_required', 'An unpaid order cannot authorize a skill');
    this.skillName = descriptor.name;
    this.skillDigest = descriptor.digest;
    this.orderId = order.id;
    this.caller = order.caller;
    this.messageId = messageId;
    this.inputDigest = order.inputDigest;
    this.#freeSkills = new Set(freeSkills);
    Object.freeze(this);
  }

  /** A purchased task may use its own skill and declared free skills, never another paid skill. */
  require(skillName: string): void {
    if (skillName !== this.skillName && !this.#freeSkills.has(skillName))
      throw new CommerceError('skill_payment_required', 'Purchase the other paid skill as a separate service');
  }
}

export interface SkillInvocation {
  orderId: string;
  messageId: string;
  taskId?: string;
  contextId?: string;
  grant: SkillGrant;
}

/**
 * An Agent-owned adapter. It must route by the passed exact skill name and use
 * grant.require() for every nested skill invocation. Raw paid skills stay private.
 */
export interface SkillRuntime {
  list(): readonly SkillDescriptor[];
  send(skillName: string, input: Input, invocation: SkillInvocation): Promise<Task>;
  getTask(skillName: string, taskId: string, invocation: SkillInvocation): Promise<Task>;
}

export interface SkillHandler {
  descriptor: SkillDescriptor;
  send(input: Input, invocation: SkillInvocation & {callSkill(name: string, input: Input): Promise<Task>}): Promise<Task>;
  getTask(taskId: string, invocation: SkillInvocation): Promise<Task>;
}

/** Reference in-process adapter: every nested skill call passes the same purchase gate. */
export function createSkillRegistry(handlers: readonly SkillHandler[]): SkillRuntime {
  const byName = new Map<string, SkillHandler>();
  for (const handler of handlers) {
    const {name, digest, cardUrl} = handler.descriptor;
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(name) || !/^[0-9a-f]{64}$/.test(digest) || !cardUrl || byName.has(name))
      throw new CommerceError('invalid_skill_registry', 'Skill names and pinned versions must be unique');
    byName.set(name, {...handler, descriptor: Object.freeze({...handler.descriptor})});
  }
  const select = (name: string, grant: SkillGrant): SkillHandler => {
    grant.require(name);
    const handler = byName.get(name);
    if (!handler) throw new CommerceError('skill_unavailable', 'The requested skill is not installed');
    return handler;
  };
  const dispatch = (name: string, input: Input, invocation: SkillInvocation, depth: number): Promise<Task> => {
    if (depth > 8) throw new CommerceError('skill_depth', 'Nested skill calls exceeded the supported limit');
    const handler = select(name, invocation.grant);
    return handler.send(input, {...invocation, callSkill: async (child, childInput) => dispatch(child, childInput, invocation, depth + 1)});
  };
  return {
    list: () => [...byName.values()].map(h => ({...h.descriptor})),
    send: (name, input, invocation) => dispatch(name, input, invocation, 0),
    getTask: (name, taskId, invocation) => select(name, invocation.grant).getTask(taskId, invocation),
  };
}

const TERMINAL = new Set([
  TaskState.TASK_STATE_COMPLETED, TaskState.TASK_STATE_FAILED, TaskState.TASK_STATE_CANCELED,
  TaskState.TASK_STATE_REJECTED, TaskState.TASK_STATE_INPUT_REQUIRED, TaskState.TASK_STATE_AUTH_REQUIRED,
]);

/** External buyer/seller communication remains ordinary A2A; only local skill dispatch changes. */
export function skillScopedExecutor(runtime: SkillRuntime, signal?: AbortSignal): ExecuteOrder {
  function descriptor(service: Service): SkillDescriptor {
    const execution = service.execution;
    if (execution.type !== 'skill' || service.id !== service.name)
      throw new CommerceError('skill_name_mismatch', 'The service must use an exact skill name');
    const matches = runtime.list().filter(s => s.name === service.id && s.digest === execution.skillDigest);
    if (matches.length !== 1 || matches[0]!.cardUrl !== execution.cardUrl)
      throw new CommerceError('skill_unavailable', 'The named installed skill or its pinned version is unavailable');
    if (matches[0]!.access === 'free' && service.offers.some(offer=>offer.pricing.kind!=='free'))
      throw new CommerceError('free_skill_price', 'A declared free helper cannot have paid offers');
    return matches[0]!;
  }

  function grant(order: OrderRecord, service: Service, messageId = order.messageId): SkillGrant {
    const selected = descriptor(service);
    const free = new Set(runtime.list().filter(s => s.access === 'free').map(s => s.name));
    return new SkillGrant(order, selected, free, messageId);
  }

  function checked(task: Task, expectedId?: string): Task {
    if (!task || typeof task.id !== 'string' || !task.id || !task.status || (expectedId && task.id !== expectedId))
      throw new CommerceError('invalid_agent_response', 'The skill runtime returned no stable A2A Task');
    return task;
  }

  async function* observe(initial: Task, order: OrderRecord, service: Service, authority: SkillGrant): AsyncIterable<Task> {
    let task = checked(initial);
    const deadline = Date.now() + service.contract.targetDurationSeconds * 1000;
    for (;;) {
      yield task;
      if (TERMINAL.has(task.status?.state ?? 0)) return;
      if (Date.now() >= deadline) throw new CommerceError('execution_pending', 'Read the original Task to continue observing execution');
      await sleep(1000, undefined, {signal});
      task = checked(await runtime.getTask(service.id, task.id, {
        orderId: order.id, messageId: authority.messageId, grant: authority,
      }), task.id);
    }
  }

  const execute: ExecuteOrder = async function* (order, service) {
    const authority = grant(order, service);
    authority.require(service.id);
    const task = await runtime.send(service.id, order.input, {
      orderId: order.id, messageId: order.messageId, grant: authority,
    });
    yield* observe(task, order, service, authority);
  };
  execute.continue = async function* (order: OrderRecord, service: Service, continuation: ContinuationRecord, remote: RemoteTaskReference) {
    if (remote.origin !== service.execution.cardUrl)
      throw new CommerceError('skill_origin_changed', 'The original skill Task belongs to another execution entry');
    const authority = grant(order, service, continuation.messageId);
    const task = checked(await runtime.send(service.id, continuation.input, {
      orderId: order.id, messageId: continuation.messageId, taskId: remote.taskId,
      contextId: remote.contextId, grant: authority,
    }), remote.taskId);
    yield* observe(task, order, service, authority);
  };
  execute.recover = async (order: OrderRecord, service: Service, remote: RemoteTaskReference) => {
    if (remote.origin !== service.execution.cardUrl)
      throw new CommerceError('skill_origin_changed', 'The original skill Task belongs to another execution entry');
    // Reading an original Task must survive a removed/upgraded installed package.
    if (service.execution.type !== 'skill') throw new CommerceError('skill_required', 'Expected a skill Task');
    const authority = new SkillGrant(order, {name:service.id,digest:service.execution.skillDigest,cardUrl:service.execution.cardUrl,access:'paid'}, new Set());
    return checked(await runtime.getTask(service.id, remote.taskId, {
      orderId: order.id, messageId: order.messageId, grant: authority,
    }), remote.taskId);
  };
  execute.assertSkill = descriptor;
  return execute;
}
