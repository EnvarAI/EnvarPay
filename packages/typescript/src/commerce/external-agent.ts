/** User-operated external agents claim and complete the original, payment-gated commerce Task. */
import { randomUUID } from "node:crypto";
import { Task, TaskState } from "@a2a-js/sdk";
import { ServerCallContext } from "@a2a-js/sdk/server";
import { CommerceStore, type OrderRecord } from "./store.js";
import type { ExecuteOrder } from "./server.js";
import { CommerceError } from "./types.js";

export class ExternalAgentExecutor {
  readonly execute: ExecuteOrder;
  constructor(
    readonly store: CommerceStore,
    readonly principal: string,
    readonly services: readonly string[],
  ) {
    if (
      !principal ||
      !services.length ||
      services.some((s) => !/^[a-z][a-z0-9-]{0,63}$/.test(s))
    )
      throw new CommerceError(
        "external_scope",
        "Configure one agent principal and explicit services",
      );
    const self = this;
    this.execute = async function* (order, service) {
      if (
        !self.services.includes(service.id) ||
        service.execution.type !== "a2a"
      )
        throw new CommerceError(
          "external_scope",
          "This external agent cannot execute that service",
        );
      self.store.prepareExternalTask(order.id, self.principal);
      const original = await self.store.load(order.taskId, self.context(order));
      if (!original)
        throw new CommerceError(
          "external_task",
          "Original commerce Task missing",
        );
      yield Task.fromJSON({
        ...(Task.toJSON(original) as Record<string, unknown>),
        status: {
          state: "TASK_STATE_INPUT_REQUIRED",
          message: {
            messageId: randomUUID(),
            role: "ROLE_AGENT",
            parts: [
              {
                text: "Waiting for the connected external agent to claim this original Task.",
              },
            ],
          },
        },
        metadata: { externalAgent: self.principal },
      });
    };
    this.execute.recover = async (order) => {
      const task = await self.store.load(order.taskId, self.context(order));
      if (!task)
        throw new CommerceError(
          "external_task",
          "Original commerce Task missing",
        );
      return task;
    };
  }
  private context(order: OrderRecord) {
    return new ServerCallContext({
      user: { isAuthenticated: true, userName: order.caller },
      tenant: order.serviceRevision,
      requestedVersion: "1.0",
    });
  }
  list() {
    return this.store.externalTasks(this.principal, this.services).map((v) => ({
      taskId: v.order.taskId,
      serviceId: v.order.serviceRevision.split(":")[0],
      claimId: v.claimId,
      state: v.order.executionState,
      input: v.order.input,
      paymentState: v.order.paymentState,
    }));
  }
  async claim(taskId: string) {
    const value = this.store.claimExternalTask(
      taskId,
      this.principal,
      this.services,
    );
    const order = value.order;
    const original = await this.store.load(taskId, this.context(order));
    if (!original)
      throw new CommerceError("external_task", "Original Task missing");
    if (
      ![TaskState.TASK_STATE_COMPLETED, TaskState.TASK_STATE_FAILED].includes(
        original.status?.state ?? 0,
      )
    )
      await this.store.save(
        Task.fromJSON({
          ...(Task.toJSON(original) as Record<string, unknown>),
          status: { state: "TASK_STATE_WORKING" },
          metadata: { ...original.metadata, externalAgent: this.principal },
        }),
        this.context(order),
      );
    return {
      taskId,
      claimId: value.claimId,
      input: order.input,
      paymentState: order.paymentState,
      state: order.executionState,
    };
  }
  async complete(
    taskId: string,
    claimId: string,
    text: string,
    failed = false,
  ) {
    if (
      typeof text !== "string" ||
      !text.trim() ||
      Buffer.byteLength(text) > 32000
    )
      throw new CommerceError(
        "external_result",
        "Return one bounded nonempty result",
      );
    const order = this.store.externalClaim(
      taskId,
      this.principal,
      claimId,
      this.services,
    );
    const original = await this.store.load(taskId, this.context(order));
    if (!original)
      throw new CommerceError("external_task", "Original Task missing");
    const state = failed
      ? TaskState.TASK_STATE_FAILED
      : TaskState.TASK_STATE_COMPLETED;
    if (
      [TaskState.TASK_STATE_COMPLETED, TaskState.TASK_STATE_FAILED].includes(
        original.status?.state ?? 0,
      )
    ) {
      const previous = original.artifacts
        .flatMap((a) => a.parts)
        .map((p) => (p.content?.$case === "text" ? p.content.value : ""))
        .join("\n");
      if (original.status?.state !== state || previous !== text)
        throw new CommerceError(
          "external_result_conflict",
          "A completed original result cannot be replaced",
        );
      return Task.toJSON(original);
    }
    const result = Task.fromJSON({
      ...(Task.toJSON(original) as Record<string, unknown>),
      status: { state: failed ? "TASK_STATE_FAILED" : "TASK_STATE_COMPLETED" },
      artifacts: [
        {
          artifactId: "external-result",
          name: "external-agent-result.txt",
          parts: [{ text, mediaType: "text/plain" }],
        },
      ],
      metadata: {
        ...original.metadata,
        externalAgent: this.principal,
        claimId,
      },
    });
    await this.store.save(result, this.context(order), original);
    return Task.toJSON(result);
  }
}
