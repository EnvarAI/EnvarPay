/** MCP Events subscription/delivery for one externally operated agent. No model or wallet credentials. */
import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { CredentialVault } from "./vault.js";
import { CommerceError } from "./types.js";
import { digest } from "./config.js";
import { ExternalAgentExecutor } from "./external-agent.js";
import { chmodSync } from "node:fs";
type Row = Record<string, string | number>;
const EVENT = "envar.task.available";
export type CallbackLookup = (
  hostname: string,
) => Promise<readonly { address: string; family: number }[]>;
const publicAddress = (a: string) => {
  if (isIP(a) === 4) {
    const p = a.split(".").map(Number);
    return (
      ![0, 10, 127].includes(p[0]!) &&
      p[0]! < 224 &&
      !(p[0] === 169 && p[1] === 254) &&
      !(p[0] === 172 && p[1]! >= 16 && p[1]! <= 31) &&
      !(p[0] === 192 && [0, 168].includes(p[1]!)) &&
      !(p[0] === 100 && p[1]! >= 64 && p[1]! <= 127) &&
      !(p[0] === 198 && [18, 19, 51].includes(p[1]!)) &&
      !(p[0] === 203 && p[1] === 0)
    );
  }
  return (
    isIP(a) === 6 &&
    /^2[0-9a-f]{3}:/i.test(a) &&
    !a.toLowerCase().startsWith("2001:db8:") &&
    !a.toLowerCase().startsWith("2001:0:")
  );
};
export async function publicWebhook(
  url: string,
  body: string,
  headers: Record<string, string>,
  resolve: CallbackLookup = (hostname) => lookup(hostname, { all: true }),
): Promise<{ status: number; body: string }> {
  const u = new URL(url);
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    u.hash ||
    (u.port && u.port !== "443")
  )
    throw new CommerceError(
      "callback_url",
      "Callback must use public HTTPS443",
    );
  const addresses = await resolve(u.hostname);
  if (!addresses.length || addresses.some((a) => !publicAddress(a.address)))
    throw new CommerceError(
      "callback_url",
      "Callback resolved to a nonpublic destination",
    );
  const address = addresses[0]!;
  return new Promise((resolve, reject) => {
    const r = httpsRequest(
      u,
      {
        method: "POST",
        headers,
        lookup: (_hostname, _options, cb) =>
          cb(null, address.address, address.family),
        timeout: 10000,
      },
      (response) => {
        let text = "";
        response.on("data", (chunk) => {
          text += chunk;
          if (Buffer.byteLength(text) > 65536)
            r.destroy(new Error("callback_size"));
        });
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, body: text }),
        );
      },
    );
    r.on("timeout", () => r.destroy(new Error("callback_timeout")));
    r.on("error", () =>
      reject(
        new CommerceError(
          "callback_failed",
          "Unable to verify or deliver callback",
        ),
      ),
    );
    r.end(body);
  });
}
export class ExternalAgentEvents {
  private readonly db: DatabaseSync;
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  constructor(
    path: string,
    private readonly agent: ExternalAgentExecutor,
    private readonly vault: CredentialVault,
    private readonly webhook = publicWebhook,
  ) {
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(
      "PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS subscriptions(id TEXT PRIMARY KEY,principal TEXT NOT NULL,callback TEXT NOT NULL,secret_ref TEXT NOT NULL,expires_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS event_delivery(subscription_id TEXT NOT NULL,task_id TEXT NOT NULL,event_id TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,after_at INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL DEFAULT 'pending',PRIMARY KEY(subscription_id,task_id))",
    );
  }
  definition() {
    return {
      events: [
        {
          name: EVENT,
          description:
            "An authorized free original Task is available for this connected Agent. Fetch and claim using the task tools.",
          delivery: ["webhook"],
          inputSchema: {
            type: "object",
            properties: {
              agent_id: { type: "string", const: this.agent.principal },
            },
            required: ["agent_id"],
            additionalProperties: false,
          },
          payloadSchema: {
            type: "object",
            properties: {
              agent_id: { type: "string" },
              task_id: { type: "string" },
              service_id: { type: "string" },
            },
            required: ["agent_id", "task_id", "service_id"],
            additionalProperties: false,
          },
        },
      ],
    };
  }
  private identity(params: Record<string, any>, principal: string) {
    if (
      principal !== this.agent.principal ||
      params.name !== EVENT ||
      digest(params.arguments) !== digest({ agent_id: principal }) ||
      params.delivery?.mode !== "webhook"
    )
      throw new CommerceError(
        "event_scope",
        "Subscribe only to this authenticated Agent",
      );
    const u = new URL(params.delivery.url);
    if (
      u.protocol !== "https:" ||
      u.username ||
      u.password ||
      u.hash ||
      (u.port && u.port !== "443")
    )
      throw new CommerceError("callback_url", "Use HTTPS443 callback");
    return {
      url: u.href,
      id:
        "sub_" +
        digest({
          principal,
          url: u.href,
          name: EVENT,
          arguments: params.arguments,
        }).slice(0, 40),
    };
  }
  private async send(
    url: string,
    secret: string,
    subscriptionId: string,
    eventId: string,
    value: unknown,
  ) {
    const body = JSON.stringify(value),
      timestamp = String(Math.floor(Date.now() / 1000));
    const key = Buffer.from(secret.slice(6), "base64");
    const signature = createHmac("sha256", key)
      .update(eventId + "." + timestamp + "." + body)
      .digest("base64");
    return this.webhook(url, body, {
      "Content-Type": "application/json",
      "webhook-id": eventId,
      "webhook-timestamp": timestamp,
      "webhook-signature": "v1," + signature,
      "X-MCP-Subscription-Id": subscriptionId,
    });
  }
  async subscribe(params: Record<string, any>, principal: string) {
    const identity = this.identity(params, principal),
      secret = params.delivery.secret;
    if (
      typeof secret !== "string" ||
      !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret) ||
      Buffer.from(secret.slice(6), "base64").length < 24 ||
      Buffer.from(secret.slice(6), "base64").length > 64
    )
      throw new CommerceError(
        "event_secret",
        "Use valid Standard Webhooks signing secret",
      );
    const ttl =
      params.ttlMs === undefined || params.ttlMs === null
        ? 3600000
        : params.ttlMs;
    if (!Number.isSafeInteger(ttl) || ttl < 60000)
      throw new CommerceError(
        "event_ttl",
        "Subscription needs at least one minute",
      );
    const expires = Date.now() + Math.min(ttl, 86400000),
      challenge = randomBytes(24).toString("base64url");
    const result = await this.send(
      identity.url,
      secret,
      identity.id,
      "verify_" + randomUUID(),
      { type: "verification", challenge },
    );
    let echoed = "";
    try {
      echoed = JSON.parse(result.body).challenge;
    } catch {}
    if (
      result.status < 200 ||
      result.status >= 300 ||
      typeof echoed !== "string" ||
      echoed.length !== challenge.length ||
      !timingSafeEqual(Buffer.from(echoed), Buffer.from(challenge))
    )
      throw new CommerceError(
        "callback_verification",
        "Callback did not echo its signed challenge",
      );
    const ref = this.vault.put({ secret });
    this.db
      .prepare(
        "INSERT INTO subscriptions VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET secret_ref=excluded.secret_ref,expires_at=excluded.expires_at",
      )
      .run(identity.id, principal, identity.url, ref, expires);
    return {
      id: identity.id,
      refreshBefore: new Date(expires).toISOString(),
      cursor: null,
      truncated: false,
    };
  }
  unsubscribe(params: Record<string, any>, principal: string) {
    const identity = this.identity(params, principal);
    this.db
      .prepare("DELETE FROM subscriptions WHERE id=? AND principal=?")
      .run(identity.id, principal);
    return {};
  }
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch(() => {}), 1000);
    this.timer.unref();
  }
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const subs = this.db
        .prepare("SELECT * FROM subscriptions WHERE expires_at>?")
        .all(Date.now()) as Row[];
      for (const sub of subs)
        for (const task of this.agent.list()) {
          if (task.claimId) continue;
          this.db
            .prepare(
              "INSERT OR IGNORE INTO event_delivery(subscription_id,task_id,event_id) VALUES (?,?,?)",
            )
            .run(
              sub.id,
              task.taskId,
              "evt_" +
                createHash("sha256")
                  .update(String(sub.id) + task.taskId)
                  .digest("hex"),
            );
          const delivery = this.db
            .prepare(
              "SELECT * FROM event_delivery WHERE subscription_id=? AND task_id=?",
            )
            .get(sub.id, task.taskId) as Row;
          if (
            delivery.state !== "pending" ||
            Number(delivery.attempts) >= 6 ||
            Number(delivery.after_at) > Date.now()
          )
            continue;
          const value = this.vault.get(String(sub.secret_ref)) as {
            secret: string;
          };
          let status = 0;
          try {
            status = (
              await this.send(
                String(sub.callback),
                value.secret,
                String(sub.id),
                String(delivery.event_id),
                {
                  eventId: delivery.event_id,
                  name: EVENT,
                  timestamp: new Date().toISOString(),
                  data: {
                    agent_id: this.agent.principal,
                    task_id: task.taskId,
                    service_id: task.serviceId,
                  },
                  cursor: null,
                },
              )
            ).status;
          } catch {}
          if (status === 410)
            this.db.prepare("DELETE FROM subscriptions WHERE id=?").run(sub.id);
          const state =
            status >= 200 && status < 300
              ? "delivered"
              : [410, 413].includes(status)
                ? "stopped"
                : "pending";
          this.db
            .prepare(
              "UPDATE event_delivery SET attempts=attempts+1,after_at=?,state=? WHERE subscription_id=? AND task_id=?",
            )
            .run(
              Date.now() +
                Math.min(60000, 1000 * 2 ** Number(delivery.attempts)),
              state,
              sub.id,
              task.taskId,
            );
        }
    } finally {
      this.running = false;
    }
  }
  inspect() {
    return {
      subscriptions: (
        this.db
          .prepare("SELECT id,principal,expires_at FROM subscriptions")
          .all() as Row[]
      ).map((r) => ({ ...r, active: Number(r.expires_at) > Date.now() })),
      deliveries: this.db
        .prepare(
          "SELECT subscription_id,task_id,event_id,attempts,state FROM event_delivery",
        )
        .all(),
    };
  }
  async close() {
    if (this.timer) clearInterval(this.timer);
    while (this.running)
      await new Promise((resolve) => setTimeout(resolve, 10));
    this.db.close();
  }
}
