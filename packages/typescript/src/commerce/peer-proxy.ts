/** Private, locally bound A2A peer access for native agents that lack a payment transport hook. */
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import {
  AgentCard,
  Task,
  Role,
  type SendMessageRequest,
  type GetTaskRequest,
} from "@a2a-js/sdk";
import {
  DefaultRequestHandler,
  JsonRpcTransportHandler,
  ServerCallContext,
  type TaskStore,
  type AgentExecutor,
} from "@a2a-js/sdk/server";
import {
  RequestMalformedError,
  TaskNotFoundError,
  UnsupportedOperationError,
} from "@a2a-js/sdk/errors";
import { CommerceBuyer, type BuyerSnapshot } from "./buyer.js";
import { CommerceError, type Input } from "./types.js";
import { digest, validateUrl } from "./config.js";
import { bearerAuthenticator } from "./server.js";

type Row = Record<string, string | number | null>;
export interface PeerProxyOptions {
  buyer: CommerceBuyer;
  buyerCaller: string;
  peerId: string;
  offerId: string;
  origin: string;
  stateDirectory: string;
  tokens: Readonly<Record<string, string>>;
  label?: string;
  waitMilliseconds?: number;
  /** Explicit opt-in for an isolated Docker/private HTTP network; public deployments require HTTPS. */
  allowPrivateHttp?: boolean;
}
const loopback = (name: string) =>
  ["localhost", "127.0.0.1", "[::1]", "::1"].includes(name);
const ref = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const safeHeaders = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "A2A-Version": "1.0",
};
function fail(code: string, message: string): never {
  throw new CommerceError(code, message);
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function envelope(params: SendMessageRequest): {
  requestId: string;
  input: Input;
} {
  const message = params.message;
  if (
    !message ||
    message.role !== Role.ROLE_USER ||
    !message.messageId ||
    message.messageId.length > 128 ||
    message.parts.length !== 1 ||
    message.referenceTaskIds.length
  )
    throw new RequestMalformedError(
      "Send one user Part with a stable requestId and input object",
    );
  const part = message.parts[0]!.content;
  let data: unknown;
  if (part?.$case === "data") data = part.value;
  else if (part?.$case === "text") {
    try {
      data = JSON.parse(part.value);
    } catch {
      throw new RequestMalformedError(
        "Native text must contain JSON {requestId,input}",
      );
    }
  } else throw new RequestMalformedError("Use one JSON data or text Part");
  if (
    !object(data) ||
    Object.keys(data).some((key) => !["requestId", "input"].includes(key)) ||
    typeof data.requestId !== "string" ||
    !ref.test(data.requestId) ||
    !object(data.input)
  )
    throw new RequestMalformedError(
      "Use exactly {requestId,input}; target and approval are local policy",
    );
  return { requestId: data.requestId, input: data.input as Input };
}
class PeerHandler extends DefaultRequestHandler {
  constructor(
    private host: A2APeerProxy,
    card: AgentCard,
    store: TaskStore,
  ) {
    const executor: AgentExecutor = {
      execute: async () => {
        throw new UnsupportedOperationError("Use the bound peer request");
      },
      cancelTask: async () => {
        throw new UnsupportedOperationError("Cancellation is not available");
      },
    };
    super(card, store, executor);
  }
  override async sendMessage(
    params: SendMessageRequest,
    context: ServerCallContext,
  ): Promise<Task> {
    return this.host.send(params, context.user!.userName);
  }
  override async getTask(
    params: GetTaskRequest,
    context: ServerCallContext,
  ): Promise<Task> {
    return this.host.read(params.id, context.user!.userName);
  }
}
/** The proxy token is never a wallet-management token. One proxy is bound to one approved peer/offer. */
export class A2APeerProxy {
  readonly origin: string;
  readonly card!: AgentCard;
  private readonly db!: DatabaseSync;
  private readonly lock: DatabaseSync;
  private readonly rpc!: JsonRpcTransportHandler;
  private readonly authenticate: ReturnType<typeof bearerAuthenticator>;
  private readonly cardUrl: string;
  private readonly waitMs: number;
  private readonly active = new Map<string, Promise<Task>>();
  private stopped = false;
  private closed = false;
  constructor(private readonly options: PeerProxyOptions) {
    const url = validateUrl(options.origin, true);
    if (
      url.pathname !== "/" ||
      url.search ||
      (!loopback(url.hostname) &&
        url.protocol !== "https:" &&
        options.allowPrivateHttp !== true)
    )
      fail(
        "proxy_origin",
        "Use loopback/HTTPS or explicitly isolated private HTTP",
      );
    this.origin = url.origin;
    this.waitMs = options.waitMilliseconds ?? 20000;
    if (
      !Number.isInteger(this.waitMs) ||
      this.waitMs < 0 ||
      this.waitMs > 25000
    )
      fail(
        "proxy_wait",
        "Proxy wait must be between zero and 25000 milliseconds",
      );
    if (!ref.test(options.buyerCaller) || !ref.test(options.offerId))
      fail("proxy_binding", "Configure a fixed buyer identity and offer");
    const peers = options.buyer.policy.peers.filter(
      (peer) => peer.id === options.peerId,
    );
    if (peers.length !== 1)
      fail("proxy_peer", "Bind exactly one locally approved peer");
    this.cardUrl = peers[0]!.cardUrl;
    this.authenticate = bearerAuthenticator(options.tokens);
    const directory = resolve(options.stateDirectory);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o077) !== 0
    )
      fail("proxy_state", "Use an owner-only proxy state directory");
    for (const name of ["owner.sqlite", "proxy.sqlite"]) {
      const path = join(directory, name);
      if (existsSync(path)) {
        const file = lstatSync(path);
        if (
          !file.isFile() ||
          file.isSymbolicLink() ||
          (file.mode & 0o077) !== 0
        )
          fail("proxy_state", "Proxy state must be private regular files");
      }
    }
    this.lock = new DatabaseSync(join(directory, "owner.sqlite"));
    chmodSync(join(directory, "owner.sqlite"), 0o600);
    try {
      this.lock.exec(
        "PRAGMA busy_timeout=0;BEGIN EXCLUSIVE;CREATE TABLE IF NOT EXISTS owner(id INTEGER PRIMARY KEY)",
      );
    } catch {
      this.lock.close();
      return fail("proxy_owned", "Another process owns this proxy state");
    }
    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(join(directory, "proxy.sqlite"));
      chmodSync(join(directory, "proxy.sqlite"), 0o600);
      database.exec(`PRAGMA journal_mode=DELETE;PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS binding(id INTEGER PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,caller TEXT NOT NULL,request_ref TEXT NOT NULL,input_digest TEXT NOT NULL,input_json TEXT NOT NULL,context_id TEXT NOT NULL,buyer_id TEXT NOT NULL DEFAULT '',phase TEXT NOT NULL,task_json TEXT NOT NULL DEFAULT '{}',UNIQUE(caller,request_ref));
    CREATE TABLE IF NOT EXISTS continuations(task_id TEXT NOT NULL,request_ref TEXT NOT NULL,message_id TEXT NOT NULL,input_digest TEXT NOT NULL,phase TEXT NOT NULL,PRIMARY KEY(task_id,request_ref));`);
      const binding = digest({
          origin: this.origin,
          buyerCaller: options.buyerCaller,
          peerId: options.peerId,
          cardUrl: this.cardUrl,
          offerId: options.offerId,
        }),
        saved = database
          .prepare("SELECT value FROM binding WHERE id=1")
          .get() as Row | undefined;
      if (saved && saved.value !== binding)
        fail(
          "proxy_binding",
          "Original proxy state belongs to a different target or wallet identity",
        );
      database
        .prepare("INSERT OR IGNORE INTO binding VALUES (1,?)")
        .run(binding);
      this.db = database;
    } catch (error) {
      database?.close();
      this.lock.exec("ROLLBACK");
      this.lock.close();
      throw error;
    }
    this.card = AgentCard.fromJSON({
      name: options.label ?? "Approved peer service",
      description:
        "Private fixed-peer access. Send JSON {requestId,input}; reuse requestId for the same intended task. Local wallet policy controls payment approval.",
      version: "1",
      supportedInterfaces: [
        {
          url: this.origin + "/a2a",
          protocolBinding: "JSONRPC",
          protocolVersion: "1.0",
        },
      ],
      capabilities: { streaming: false, pushNotifications: false },
      defaultInputModes: ["application/json", "text/plain"],
      defaultOutputModes: ["text/plain", "application/json"],
      skills: [
        {
          id: options.peerId,
          name: options.label ?? options.peerId,
          description:
            "Use a stable requestId for retry safety and the declared input of the approved service. GetTask retrieves the original result without approving payment.",
          tags: ["a2a", "private-peer"],
          examples: [
            '{"requestId":"research-job-001","input":{"request":"Summarize the sources"}}',
          ],
        },
      ],
      securitySchemes: {
        bearer: { httpAuthSecurityScheme: { scheme: "bearer" } },
      },
      securityRequirements: [{ schemes: { bearer: { list: [] } } }],
    });
    const store: TaskStore = {
      load: (id, ctx) => this.read(id, ctx.user!.userName),
      save: async () => {
        throw new UnsupportedOperationError(
          "Tasks are saved with the original buyer purchase",
        );
      },
      list: async () => {
        throw new UnsupportedOperationError("Task listing is not exposed");
      },
    };
    this.rpc = new JsonRpcTransportHandler(
      new PeerHandler(this, this.card, store),
    );
  }
  private row(id: string, caller: string): Row {
    const row = this.db
      .prepare("SELECT * FROM tasks WHERE id=? AND caller=?")
      .get(id, caller) as Row | undefined;
    if (!row) throw new TaskNotFoundError("Original peer Task not found");
    return row;
  }
  private phase(id: string, phase: string, buyerId?: string) {
    if (buyerId === undefined)
      this.db.prepare("UPDATE tasks SET phase=? WHERE id=?").run(phase, id);
    else
      this.db
        .prepare("UPDATE tasks SET phase=?,buyer_id=? WHERE id=?")
        .run(phase, buyerId, id);
  }
  private projection(row: Row, snapshot?: BuyerSnapshot, code?: string): Task {
    let raw: Record<string, unknown> = snapshot?.task
      ? structuredClone(snapshot.task)
      : {};
    if (!code && ["created", "attention", "failed", "unknown"].includes(String(row.phase))) {
      try {
        const previous = JSON.parse(String(row.task_json));
        if (typeof previous.metadata?.errorCode === "string")
          code = previous.metadata.errorCode;
      } catch {}
    }
    if (code && !/^[a-z][a-z0-9_]{0,63}$/.test(code))
      code = "peer_request_failed";
    const quote = snapshot?.quote,
      phase = String(row.phase),
      needsApproval =
        phase === "waiting_owner" && snapshot?.state === "previewed";
    const unknown =
      ((phase === "unknown" ||
        (phase === "confirming" && !this.active.has(String(row.id)))) &&
        !["completed", "failed", "canceled", "rejected"].includes(
          snapshot?.executionState ?? "",
        )) ||
      snapshot?.state === "unknown";
    if (!snapshot?.task) {
      const failed = phase === "failed" || snapshot?.state === "rejected";
      raw = {
        status: {
          state: needsApproval
            ? "TASK_STATE_AUTH_REQUIRED"
            : phase === "attention"
              ? "TASK_STATE_INPUT_REQUIRED"
              : failed
              ? "TASK_STATE_FAILED"
              : "TASK_STATE_WORKING",
        },
      };
    }
    const status = (raw.status ?? {}) as Record<string, unknown>;
    let message = "";
    if (needsApproval)
      message = `Owner approval required. Review original buyer purchase ${row.buyer_id} with the separate private wallet console. No payment was approved by this agent. Proxy Task: ${row.id}.`;
    else if (unknown)
      message = `Original outcome is uncertain. Owner should inspect/recover buyer purchase ${row.buyer_id || "with original message " + row.id}. Do not create a replacement requestId. Proxy Task: ${row.id}.`;
    else if (code)
      message = `Peer operation needs attention (${code}). Proxy Task: ${row.id}.`;
    else if (!snapshot?.task)
      message = `Original peer purchase is ${snapshot?.executionState ?? phase}. Read GetTask ${row.id} for progress.`;
    if (message)
      status.message = {
        messageId: `status-${row.id}`,
        role: "ROLE_AGENT",
        taskId: row.id,
        contextId: row.context_id,
        parts: [{ text: message }],
      };
    const task = Task.fromJSON({
      ...raw,
      id: row.id,
      contextId: row.context_id,
      status,
      metadata: {
        proxyRequestId: row.request_ref,
        buyerPurchaseId: row.buyer_id,
        ...(code ? { errorCode: code } : {}),
        ...(quote
          ? {
              payment: {
                state: snapshot!.paymentState,
                amount: quote.amount,
                currency: quote.currency,
                recipient: quote.recipient,
              },
            }
          : {}),
        ...(needsApproval ? { approvalRequired: true } : {}),
        ...(unknown ? { recoveryRequired: true } : {}),
      },
    });
    for (const entry of [
      ...task.history,
      ...(task.status?.message ? [task.status.message] : []),
    ]) {
      entry.taskId = task.id;
      entry.contextId = task.contextId;
    }
    this.db
      .prepare("UPDATE tasks SET task_json=? WHERE id=?")
      .run(JSON.stringify(Task.toJSON(task)), row.id);
    return task;
  }
  private async exclusive(
    id: string,
    action: () => Promise<Task>,
  ): Promise<Task> {
    const existing = this.active.get(id);
    if (existing) return existing;
    const running = action();
    this.active.set(id, running);
    try {
      return await running;
    } finally {
      this.active.delete(id);
    }
  }
  private snapshot(row: Row): BuyerSnapshot | undefined {
    return row.buyer_id
      ? this.options.buyer.get(this.options.buyerCaller, String(row.buyer_id))
      : undefined;
  }
  private async wait(
    row: Row,
    snapshot: BuyerSnapshot,
    immediate: boolean,
  ): Promise<Task> {
    if (immediate)
      return this.projection(
        this.row(String(row.id), String(row.caller)),
        snapshot,
      );
    const deadline = Date.now() + this.waitMs;
    let value = snapshot;
    while (
      !this.stopped &&
      Date.now() < deadline &&
      ["working", "queued", "dispatching", "not_started"].includes(
        value.executionState,
      ) &&
      !["previewed", "unknown", "rejected"].includes(value.state)
    ) {
      await sleep(250);
      value = this.options.buyer.get(
        this.options.buyerCaller,
        String(row.buyer_id),
      );
    }
    return this.projection(this.row(String(row.id), String(row.caller)), value);
  }
  async send(params: SendMessageRequest, caller: string): Promise<Task> {
    if (this.stopped) fail("proxy_stopping", "Peer proxy is stopping");
    const body = envelope(params),
      message = params.message!;
    if (message.taskId) {
      const row = this.row(message.taskId, caller);
      if (!row.buyer_id)
        throw new UnsupportedOperationError(
          "Original purchase is not ready for clarification",
        );
      return this.exclusive(String(row.id), async () => {
        const prior = this.db
          .prepare(
            "SELECT * FROM continuations WHERE task_id=? AND request_ref=?",
          )
          .get(row.id, body.requestId) as Row | undefined;
        if (prior) {
          if (prior.input_digest !== digest(body.input))
            fail(
              "proxy_request_conflict",
              "Clarification reference already has different input",
            );
          return this.read(String(row.id), caller);
        }
        const messageId = randomUUID();
        this.db
          .prepare("INSERT INTO continuations VALUES (?,?,?,?,?)")
          .run(
            row.id,
            body.requestId,
            messageId,
            digest(body.input),
            "sending",
          );
        try {
          const snapshot = await this.options.buyer.continue(
            this.options.buyerCaller,
            String(row.buyer_id),
            { messageId, input: body.input },
          );
          this.db
            .prepare(
              "UPDATE continuations SET phase='observed' WHERE task_id=? AND request_ref=?",
            )
            .run(row.id, body.requestId);
          return this.projection(row, snapshot);
        } catch (error) {
          this.db
            .prepare(
              "UPDATE continuations SET phase='unknown' WHERE task_id=? AND request_ref=?",
            )
            .run(row.id, body.requestId);
          this.phase(String(row.id), "unknown");
          return this.projection(
            this.row(String(row.id), caller),
            this.snapshot(row),
            error instanceof CommerceError
              ? error.code
              : "continuation_unknown",
          );
        }
      });
    }
    let row = this.db
      .prepare("SELECT * FROM tasks WHERE caller=? AND request_ref=?")
      .get(caller, body.requestId) as Row | undefined;
    if (row && row.input_digest !== digest(body.input))
      fail(
        "proxy_request_conflict",
        "Original requestId already identifies different input",
      );
    if (!row) {
      const id = randomUUID(),
        contextId =
          message.contextId && ref.test(message.contextId)
            ? message.contextId
            : randomUUID();
      this.db
        .prepare(
          "INSERT INTO tasks(id,caller,request_ref,input_digest,input_json,context_id,phase) VALUES (?,?,?,?,?,?,?)",
        )
        .run(
          id,
          caller,
          body.requestId,
          digest(body.input),
          JSON.stringify(body.input),
          contextId,
          "created",
        );
      row = this.row(id, caller);
    }
    const id = String(row.id);
    const running = this.exclusive(id, async () => {
      let current = this.row(id, caller),
        snapshot = this.snapshot(current);
      if (current.phase === "confirming") {
        this.phase(id, "unknown");
        current = this.row(id, caller);
      }
      if (
        current.phase === "waiting_owner" ||
        current.phase === "tracking" ||
        current.phase === "unknown" ||
        current.phase === "failed"
      )
        return this.projection(current, snapshot);
      try {
        const allowed = this.options.buyer
          .policySnapshot()
          .peers.find(
            (peer) =>
              peer.id === this.options.peerId && peer.cardUrl === this.cardUrl,
          );
        if (!allowed)
          fail(
            "proxy_peer_changed",
            "The original fixed peer is no longer approved locally",
          );
        if (!snapshot) {
          this.phase(id, "previewing");
          snapshot = await this.options.buyer.preview(
            this.options.buyerCaller,
            {
              cardUrl: this.cardUrl,
              messageId: id,
              offerId: this.options.offerId,
              input: body.input,
            },
          );
          this.phase(id, "previewed", snapshot.id);
          current = this.row(id, caller);
        }
        // Direct local Buyer reference makes the policy check and confirm invocation one process boundary.
        // The caller cannot supply a target, quoteToken, approval flag or policy override.
        const policy = this.options.buyer.policySnapshot();
        if (policy.approval !== "within_preapproved_limits") {
          this.phase(id, "waiting_owner");
          return this.projection(this.row(id, caller), snapshot);
        }
        const approvedPeer = policy.peers.find(
          (peer) =>
            peer.id === this.options.peerId && peer.cardUrl === this.cardUrl,
        );
        if (!approvedPeer)
          fail(
            "proxy_peer_changed",
            "The original fixed peer is no longer approved locally",
          );
        if (approvedPeer.protocol !== "free" && !policy.paymentsEnabled)
          fail("payments_disabled", "Payments are disabled in local policy");
        this.phase(id, "confirming");
        snapshot = await this.options.buyer.confirm(this.options.buyerCaller, {
          previewId: snapshot.id,
          quoteToken: snapshot.quoteToken,
          messageId: id,
        });
        this.phase(id, snapshot.state === "unknown" ? "unknown" : "tracking");
        return this.wait(
          this.row(id, caller),
          snapshot,
          params.configuration?.returnImmediately === true,
        );
      } catch (error) {
        const state = this.row(id, caller).phase;
        const definitelyBlocked =
          error instanceof CommerceError &&
          [
            "payments_disabled",
            "budget_exceeded",
            "approval_mismatch",
            "quote_expired",
            "policy_changed",
            "proxy_peer_changed",
            "peer_not_allowed",
            "invalid_input",
            "purchase_limit",
            "paid_quote_required",
            "offer_metadata_required",
            "quote_mismatch",
            "retired_revision",
          ].includes(error.code);
        this.phase(
          id,
          definitelyBlocked
            ? state === "previewing" ? "attention" : "failed"
            : state === "confirming"
              ? "unknown"
              : state === "previewing"
                ? "created"
                : "failed",
        );
        return this.projection(
          this.row(id, caller),
          snapshot,
          error instanceof CommerceError ? error.code : "peer_request_failed",
        );
      }
    });
    if (params.configuration?.returnImmediately === true) {
      void running.catch(() => undefined);
      return this.projection(
        this.row(id, caller),
        this.snapshot(this.row(id, caller)),
      );
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        running,
        new Promise<Task>((resolve) => {
          timer = setTimeout(() => {
            const current = this.row(id, caller);
            resolve(this.projection(current, this.snapshot(current)));
          }, this.waitMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  async read(id: string, caller: string): Promise<Task> {
    const row = this.row(id, caller);
    const snapshot = this.snapshot(row);
    if (
      snapshot &&
      snapshot.state !== "previewed" &&
      snapshot.state !== "unknown" &&
      ["waiting_owner", "unknown", "confirming"].includes(String(row.phase))
    )
      this.phase(id, "tracking");
    return this.projection(this.row(id, caller), snapshot);
  }
  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (
      url.origin !== this.origin ||
      (request.headers.get("Host") && request.headers.get("Host") !== url.host)
    )
      return Response.json(
        { error: "invalid_host" },
        { status: 421, headers: safeHeaders },
      );
    if (
      request.headers.get("Origin") &&
      request.headers.get("Origin") !== this.origin
    )
      return Response.json(
        { error: "origin_not_allowed" },
        { status: 403, headers: safeHeaders },
      );
    if (
      request.method === "GET" &&
      url.pathname === "/.well-known/agent-card.json" &&
      !url.search
    )
      return Response.json(AgentCard.toJSON(this.card), {
        headers: safeHeaders,
      });
    if (request.method !== "POST" || url.pathname !== "/a2a" || url.search)
      return Response.json(
        { error: "not_found" },
        { status: 404, headers: safeHeaders },
      );
    const caller = await this.authenticate(request);
    if (!caller)
      return Response.json(
        { error: "authentication_required" },
        {
          status: 401,
          headers: { ...safeHeaders, "WWW-Authenticate": "Bearer" },
        },
      );
    if (this.stopped)
      return Response.json(
        { error: "proxy_stopping" },
        { status: 503, headers: safeHeaders },
      );
    if (
      [
        "PAYMENT-SIGNATURE",
        "Payment-Authorization",
        "Payment-Receipt",
        "PAYMENT-RESPONSE",
      ].some((name) => request.headers.has(name))
    )
      return Response.json(
        { error: "proxy_payment_credentials_forbidden" },
        { status: 400, headers: safeHeaders },
      );
    let id: unknown = null;
    try {
      const version = request.headers.get("A2A-Version");
      if (version && version !== "1.0")
        throw new RequestMalformedError("This endpoint supports A2A 1.0 only");
      if (
        !request.headers
          .get("Content-Type")
          ?.toLowerCase()
          .startsWith("application/json")
      )
        throw new RequestMalformedError("Send application/json");
      const chunks: Uint8Array[] = [];
      let length = 0;
      if (request.body) {
        const reader = request.body.getReader();
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          length += part.value.byteLength;
          if (length > 1048576) {
            await reader.cancel();
            return Response.json(
              { error: "request_too_large" },
              { status: 413, headers: safeHeaders },
            );
          }
          chunks.push(part.value);
        }
      }
      const body = Buffer.concat(chunks).toString("utf8"),
        raw = JSON.parse(body);
      id = raw?.id ?? null;
      const validId =
        (typeof id === "string" && id.length > 0 && id.length <= 128) ||
        (typeof id === "number" && Number.isSafeInteger(id));
      if (!validId) {
        id = null;
        throw new RequestMalformedError(
          "A bounded JSON-RPC request ID is required",
        );
      }
      if (
        !object(raw) ||
        raw.jsonrpc !== "2.0" ||
        !(
          (typeof id === "string" && id.length <= 128) ||
          (typeof id === "number" && Number.isSafeInteger(id))
        ) ||
        !["SendMessage", "GetTask"].includes(String(raw.method)) ||
        !object(raw.params)
      )
        throw new RequestMalformedError(
          "Use one canonical SendMessage or GetTask request",
        );
      if (
        Object.keys(raw.params).some(
          (key) =>
            !["message", "configuration", "id", "historyLength"].includes(key),
        )
      )
        throw new RequestMalformedError("Unsupported routing metadata");
      if (raw.method === "SendMessage") {
        const m = raw.params.message,
          c = raw.params.configuration;
        if (
          !object(m) ||
          Object.keys(m).some(
            (key) =>
              !["messageId", "role", "parts", "contextId", "taskId"].includes(
                key,
              ),
          ) ||
          (c !== undefined &&
            (!object(c) ||
              Object.keys(c).some((key) => key !== "returnImmediately") ||
              typeof c.returnImmediately !== "boolean"))
        )
          throw new RequestMalformedError(
            "Unsupported message fields or configuration",
          );
      }
      const result = await this.rpc.handle(
        body,
        new ServerCallContext({
          user: { isAuthenticated: true, userName: caller },
          requestedVersion: "1.0",
        }),
      );
      if (Symbol.asyncIterator in result)
        throw new UnsupportedOperationError("Streaming is not available");
      return Response.json(result, { headers: safeHeaders });
    } catch (error) {
      const code =
        error instanceof CommerceError ? error.code : "invalid_request";
      return Response.json(
        {
          jsonrpc: "2.0",
          id,
          error:
            error instanceof CommerceError
              ? { code: -32000, message: code }
              : JsonRpcTransportHandler.mapToJSONRPCError(error),
        },
        { headers: safeHeaders },
      );
    }
  }
  assertListenHost(host: string): void {
    if (
      !loopback(host) &&
      new URL(this.origin).protocol !== "https:" &&
      this.options.allowPrivateHttp !== true
    )
      fail(
        "proxy_bind",
        "Non-loopback HTTP bind requires explicit private-network opt-in",
      );
  }
  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled([...this.active.values()]);
  }
  close(): void {
    if (this.closed) return;
    if (this.active.size)
      fail("proxy_busy", "Stop and drain the proxy before closing");
    this.db.close();
    this.lock.exec("ROLLBACK");
    this.lock.close();
    this.closed = true;
  }
}
export function listenPeerProxy(
  proxy: A2APeerProxy,
  host = "127.0.0.1",
  port = 4030,
) {
  proxy.assertListenHost(host);
  const http = createServer(async (req, res) => {
    try {
      if (req.headers.host !== new URL(proxy.origin).host) {
        res.writeHead(421, safeHeaders);
        res.end('{"error":"invalid_host"}');
        return;
      }
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers))
        if (value !== undefined)
          headers.set(key, Array.isArray(value) ? value.join(",") : value);
      const request = new Request(new URL(req.url ?? "/", proxy.origin), {
        method: req.method,
        headers,
        ...(req.method !== "GET" && req.method !== "HEAD"
          ? {
              body: Readable.toWeb(req) as ReadableStream<Uint8Array>,
              duplex: "half",
            }
          : {}),
      } as RequestInit);
      const response = await proxy.handle(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body)
        Readable.fromWeb(
          response.body as Parameters<typeof Readable.fromWeb>[0],
        ).pipe(res);
      else res.end();
    } catch {
      if (!res.headersSent) res.writeHead(500, safeHeaders);
      res.end('{"error":"peer_request_failed"}');
    }
  });
  http.requestTimeout = 30000;
  http.headersTimeout = 15000;
  http.listen(port, host);
  return http;
}
