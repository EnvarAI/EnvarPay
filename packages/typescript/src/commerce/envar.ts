/** Optional directory integration; independent A2A/payment paths never import this module. */
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { atomic, currencyOf, digest, loadCommerceConfig } from "./config.js";
import {
  CommerceError,
  type CommerceConfig,
  type PriceQuote,
} from "./types.js";
type Row = Record<string, string | number | null>;
const UUID =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  HASH = /^0x[0-9a-f]{64}$/i,
  ADDRESS = /^0x[0-9a-f]{40}$/i,
  ID = /^[a-z][a-z0-9-]{0,63}$/;
const STATUS_KINDS = [
  "seller_started",
  "seller_completed",
  "seller_failed",
  "buyer_received",
  "buyer_failed",
  "execution_unknown",
] as const;
export type EnvarStatusKind = (typeof STATUS_KINDS)[number];
export interface EnvarPolicy {
  enabled: true;
  platformOrigin: string;
  agentId: string;
  runtimeAgentId: string;
  acceptUpdates: boolean;
  allowedServices: string[];
  allowedUpstreamOrigins: string[];
  allowedX402: {
    network: string;
    asset: string;
    payTo: string;
    facilitatorOrigin: string;
  }[];
  allowedMppAccounts: string[];
}
export interface EnvarCandidate {
  id: string;
  service_id: string;
  revision: number;
  digest: string;
  config: CommerceConfig;
  publication: { state: string; desired_digest: string };
}
export interface EnvarApplicationProof {
  digest: string;
  services: { id: string; revision: number; digest: string }[];
}
export interface EnvarIntegrationOptions {
  policy: EnvarPolicy;
  stateDirectory: string;
  configDirectory: string;
  /** Dedicated Agent-scoped credential, read locally; never persisted here. */
  token: () => string | Promise<string>;
  fetch?: typeof fetch;
  timeoutMs?: number;
  responseLimitBytes?: number;
  now?: () => number;
}
export interface EnvarX402Evidence {
  network: string;
  asset: string;
  payer: string;
  recipient: string;
  amount: string;
  nonce: string;
  transaction: string;
}
export interface EnvarMppEvidence {
  reference: string;
  amount: string;
  currency: string;
}
function fail(code: string, message: string): never {
  throw new CommerceError(code, message);
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function uuid(value: string) {
  if (typeof value !== "string" || !UUID.test(value))
    fail("envar_identifier", "Use a UUID platform identifier");
}
function origin(value: string, allowHttp = false): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail("envar_origin", "Configure an absolute allowed origin");
  }
  if (
    !["https:", ...(allowHttp ? ["http:"] : [])].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    fail(
      "envar_origin",
      "Use an exact origin without credentials, path, query or fragment",
    );
  return url.origin;
}
function secureDirectory(path: string): string {
  const directory = resolve(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
    fail(
      "envar_private_directory",
      "Use a real owner-only integration directory (0700)",
    );
  return directory;
}
function secureFile(path: string) {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
    fail(
      "envar_private_file",
      "Integration files must be owner-only regular files",
    );
}
function atomicJson(path: string, value: unknown) {
  secureFile(path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
      flush: true,
    });
    renameSync(temporary, path);
    const fd = openSync(resolve(path, ".."), "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
/** Same frozen fingerprint as CommerceStore.registerCatalog; callers must read actual persisted state. */
export function envarServiceProofs(
  config: CommerceConfig,
): EnvarApplicationProof["services"] {
  return config.services.map((service) => ({
    id: service.id,
    revision: service.revision,
    digest: digest({
      service,
      profiles: Object.fromEntries(
        service.offers
          .filter((o) => o.paymentProfile)
          .map((o) => [
            o.paymentProfile!,
            config.paymentProfiles[o.paymentProfile!],
          ]),
      ),
    }),
  }));
}
export class EnvarIntegration {
  readonly sourceInstance!: string;
  private readonly policy: EnvarPolicy;
  private readonly db!: DatabaseSync;
  private readonly lock!: DatabaseSync;
  private readonly configDirectory: string;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly limitBytes: number;
  private flushing = false;
  private applying = false;
  private closed = false;
  constructor(private readonly options: EnvarIntegrationOptions) {
    if (options.policy.enabled !== true)
      fail(
        "envar_not_enabled",
        "Envar integration requires explicit local opt-in",
      );
    this.policy = structuredClone(options.policy);
    this.policy.platformOrigin = origin(this.policy.platformOrigin);
    uuid(this.policy.agentId);
    if (typeof this.policy.acceptUpdates !== "boolean")
      fail("envar_policy", "acceptUpdates must be an explicit local boolean");
    if (
      !ID.test(this.policy.runtimeAgentId) ||
      this.policy.allowedServices.some((id) => !ID.test(id))
    )
      fail("envar_policy", "Configure valid local Agent and service IDs");
    this.policy.allowedUpstreamOrigins = this.policy.allowedUpstreamOrigins.map(
      (url) => origin(url, true),
    );
    this.policy.allowedX402 = this.policy.allowedX402.map((entry) => {
      if (
        !/^eip155:[1-9][0-9]*$/.test(entry.network) ||
        !ADDRESS.test(entry.asset) ||
        !ADDRESS.test(entry.payTo)
      )
        fail("envar_policy", "Configure explicit receiving identities");
      return {
        ...entry,
        asset: entry.asset.toLowerCase(),
        payTo: entry.payTo.toLowerCase(),
        facilitatorOrigin: origin(entry.facilitatorOrigin),
      };
    });
    if (this.policy.allowedMppAccounts.some((id) => !ID.test(id)))
      fail("envar_policy", "Configure explicit merchant account references");
    this.timeoutMs = options.timeoutMs ?? 10000;
    this.limitBytes = options.responseLimitBytes ?? 1048576;
    if (
      !Number.isInteger(this.timeoutMs) ||
      this.timeoutMs < 100 ||
      this.timeoutMs > 60000 ||
      !Number.isInteger(this.limitBytes) ||
      this.limitBytes < 1024 ||
      this.limitBytes > 4194304
    )
      fail("envar_limits", "Configure bounded HTTP time and response limits");
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    const directory = secureDirectory(options.stateDirectory);
    this.configDirectory = secureDirectory(options.configDirectory);
    const lockPath = join(directory, "owner.sqlite"),
      dbPath = join(directory, "integration.sqlite");
    secureFile(lockPath);
    secureFile(dbPath);
    const lock = new DatabaseSync(lockPath);
    chmodSync(lockPath, 0o600);
    try {
      lock.exec(
        "PRAGMA busy_timeout=0; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY);",
      );
    } catch {
      lock.close();
      return fail(
        "envar_integration_owned",
        "Another process already owns this integration state",
      );
    }
    this.lock = lock;
    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(dbPath);
      chmodSync(dbPath, 0o600);
      database.exec(`PRAGMA journal_mode=DELETE;PRAGMA synchronous=FULL;PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS revisions (id TEXT PRIMARY KEY,service_id TEXT NOT NULL,local_service TEXT NOT NULL,revision INTEGER NOT NULL,digest TEXT NOT NULL,config_json TEXT NOT NULL,state TEXT NOT NULL,UNIQUE(local_service,revision));
    CREATE TABLE IF NOT EXISTS outbox (event_id TEXT PRIMARY KEY,dedupe_key TEXT UNIQUE NOT NULL,kind TEXT NOT NULL,payload_json TEXT NOT NULL,digest TEXT NOT NULL,state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_attempt INTEGER NOT NULL DEFAULT 0,last_error TEXT NOT NULL DEFAULT '');`);
      const binding = JSON.stringify({
        platformOrigin: this.policy.platformOrigin,
        agentId: this.policy.agentId,
        runtimeAgentId: this.policy.runtimeAgentId,
      });
      const prior = database
        .prepare("SELECT value FROM meta WHERE key=?")
        .get("binding") as Row | undefined;
      if (prior && prior.value !== binding)
        fail(
          "envar_state_binding",
          "This private state belongs to a different platform or Agent",
        );
      database
        .prepare("INSERT OR IGNORE INTO meta VALUES (?,?)")
        .run("binding", binding);
      database
        .prepare("INSERT OR IGNORE INTO meta VALUES (?,?)")
        .run("source_instance", randomUUID());
      this.sourceInstance = String(
        (
          database
            .prepare("SELECT value FROM meta WHERE key=?")
            .get("source_instance") as Row
        ).value,
      );
      this.db = database;
    } catch (error) {
      database?.close();
      lock.exec("ROLLBACK");
      lock.close();
      throw error;
    }
  }
  close() {
    if (this.closed) return;
    if (this.applying || this.flushing)
      fail(
        "envar_busy",
        "Wait for current integration operations before closing",
      );
    this.db.close();
    this.lock.exec("ROLLBACK");
    this.lock.close();
    this.closed = true;
  }
  private open() {
    if (this.closed) fail("envar_closed", "Integration is closed");
  }
  private async request(
    path: string,
    payload?: unknown,
    eventId?: string,
  ): Promise<Record<string, unknown>> {
    this.open();
    if (
      ![
        "/api/v1/agent-config/candidates",
        "/api/v1/agent-config/acknowledgments",
        "/api/v1/commerce-reports",
      ].includes(path)
    )
      fail("envar_path", "Unsupported platform integration operation");
    const token = await this.options.token();
    if (
      typeof token !== "string" ||
      token.length < 32 ||
      token.length > 4096 ||
      /\s/.test(token)
    )
      fail("envar_token", "Use a dedicated Agent-scoped platform credential");
    const url = this.policy.platformOrigin + path;
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: payload === undefined ? "GET" : "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          ...(payload === undefined
            ? {}
            : {
                "Content-Type": "application/json",
                "Idempotency-Key": eventId!,
              }),
        },
        body: payload === undefined ? undefined : JSON.stringify(payload),
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      return fail(
        "envar_transport",
        "Platform request did not complete; retain the original integration event",
      );
    }
    if (
      response.redirected ||
      (response.url && response.url !== url) ||
      (response.status >= 300 && response.status < 400)
    ) {
      await response.body?.cancel();
      fail(
        "envar_redirect",
        "Platform credentials must never follow redirects",
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      return fail(
        `envar_http_${response.status}`,
        `Platform returned HTTP ${response.status}; retain the original event`,
      );
    }
    if (
      Number(response.headers.get("content-length") ?? "0") > this.limitBytes
    ) {
      await response.body?.cancel();
      return fail(
        "envar_response_size",
        "Platform response exceeds the configured limit",
      );
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = response.body?.getReader();
    if (reader) {
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > this.limitBytes) {
            await reader.cancel();
            fail(
              "envar_response_size",
              "Platform response exceeds the configured limit",
            );
          }
          chunks.push(next.value);
        }
      } finally {
        reader.releaseLock();
      }
    }
    let value: unknown;
    try {
      value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return fail("envar_response_json", "Platform returned invalid JSON");
    }
    if (!object(value))
      fail("envar_response_json", "Platform response must be an object");
    return value;
  }
  private candidate(value: unknown): EnvarCandidate {
    if (!this.policy.acceptUpdates)
      fail(
        "envar_updates_disabled",
        "Local owner has not enabled platform configuration updates",
      );
    if (
      !object(value) ||
      typeof value.id !== "string" ||
      typeof value.service_id !== "string" ||
      typeof value.digest !== "string"
    )
      fail("envar_candidate", "Invalid service revision candidate");
    uuid(value.id);
    uuid(value.service_id);
    const config = loadCommerceConfig(value.config);
    if (
      config.agent.id !== this.policy.runtimeAgentId ||
      config.services.length !== 1
    )
      fail(
        "envar_candidate_agent",
        "Candidate does not match the locally linked Agent",
      );
    const service = config.services[0]!;
    if (
      service.revision !== value.revision ||
      !this.policy.allowedServices.includes(service.id)
    )
      fail(
        "envar_candidate_service",
        "Candidate service is outside the local update grant",
      );
    if (
      digest(config) !== value.digest ||
      !object(value.publication) ||
      value.publication.desired_digest !== value.digest ||
      ![
        "awaiting_application",
        "applied",
        "probe_failed",
        "published",
      ].includes(String(value.publication.state))
    )
      fail(
        "envar_candidate_digest",
        "Candidate and publication digests must match",
      );
    if (
      !this.policy.allowedUpstreamOrigins.includes(
        new URL(service.execution.cardUrl).origin,
      )
    )
      fail(
        "envar_upstream_denied",
        "Upstream origin is outside the local update grant",
      );
    for (const profile of Object.values(config.paymentProfiles)) {
      if (profile.adapter === "x402") {
        if (
          !this.policy.allowedX402.some(
            (a) =>
              a.network === profile.network &&
              a.asset === profile.asset.toLowerCase() &&
              a.payTo === profile.payTo.toLowerCase() &&
              a.facilitatorOrigin === new URL(profile.facilitatorUrl).origin,
          )
        )
          fail(
            "envar_recipient_denied",
            "Receiving identity or facilitator is outside the local update grant",
          );
      } else if (!this.policy.allowedMppAccounts.includes(profile.accountRef))
        fail(
          "envar_merchant_denied",
          "Merchant account is outside the local update grant",
        );
    }
    const prior = this.db
      .prepare(
        "SELECT * FROM revisions WHERE id=? OR (local_service=? AND revision=?)",
      )
      .all(value.id, service.id, service.revision) as Row[];
    if (
      prior.some(
        (row) =>
          row.id !== value.id ||
          row.service_id !== value.service_id ||
          row.digest !== value.digest,
      )
    )
      fail(
        "envar_revision_conflict",
        "A historical service revision cannot change",
      );
    const mapped = this.db
      .prepare("SELECT service_id FROM revisions WHERE local_service=? LIMIT 1")
      .get(service.id) as Row | undefined;
    if (mapped && mapped.service_id !== value.service_id)
      fail(
        "envar_service_mapping",
        "Local service is already mapped to a different platform service",
      );
    return {
      id: value.id,
      service_id: value.service_id,
      revision: service.revision,
      digest: value.digest,
      config,
      publication: {
        state: String(value.publication.state),
        desired_digest: String(value.publication.desired_digest),
      },
    };
  }
  /** Latest locally acknowledged revisions; startup recovery never requires platform connectivity. */
  appliedCandidates(): EnvarCandidate[] {
    this.open();
    const rows = this.db
      .prepare(
        "SELECT r.* FROM revisions r WHERE r.state='applied' AND r.revision=(SELECT MAX(n.revision) FROM revisions n WHERE n.local_service=r.local_service AND n.state='applied') ORDER BY r.local_service",
      )
      .all() as Row[];
    return rows.map((row) => {
      const config = loadCommerceConfig(JSON.parse(String(row.config_json)));
      if (
        digest(config) !== row.digest ||
        config.agent.id !== this.policy.runtimeAgentId
      )
        fail("envar_config_integrity", "Saved applied candidate changed");
      const path = join(
        this.configDirectory,
        `${config.services[0]!.id}-v${row.revision}-${row.digest}.json`,
      );
      secureFile(path);
      if (
        !existsSync(path) ||
        digest(JSON.parse(readFileSync(path, "utf8"))) !== row.digest
      )
        fail(
          "envar_config_integrity",
          "Saved applied configuration file changed",
        );
      return {
        id: String(row.id),
        service_id: String(row.service_id),
        revision: Number(row.revision),
        digest: String(row.digest),
        config,
        publication: { state: "applied", desired_digest: String(row.digest) },
      };
    });
  }
  /** Recover only pending applications already proven by the runtime's durable service catalog. */
  pendingCandidates(
    registered: EnvarApplicationProof["services"],
  ): EnvarCandidate[] {
    this.open();
    const rows = this.db
      .prepare("SELECT * FROM revisions WHERE state='pending'")
      .all() as Row[];
    const results: EnvarCandidate[] = [];
    for (const row of rows) {
      const config = loadCommerceConfig(JSON.parse(String(row.config_json)));
      if (
        !envarServiceProofs(config).every((expected) =>
          registered.some((actual) => digest(actual) === digest(expected)),
        )
      )
        continue;
      const candidate = this.candidate({
        id: String(row.id),
        service_id: String(row.service_id),
        revision: Number(row.revision),
        digest: String(row.digest),
        config,
        publication: {
          state: "awaiting_application",
          desired_digest: String(row.digest),
        },
      });
      const path = join(
        this.configDirectory,
        `${config.services[0]!.id}-v${row.revision}-${row.digest}.json`,
      );
      secureFile(path);
      if (
        !existsSync(path) ||
        digest(JSON.parse(readFileSync(path, "utf8"))) !== row.digest
      )
        fail(
          "envar_config_integrity",
          "Pending applied configuration file changed",
        );
      results.push(candidate);
    }
    return results;
  }
  async pullCandidates(): Promise<EnvarCandidate[]> {
    this.open();
    if (!this.policy.acceptUpdates) return [];
    const response = await this.request("/api/v1/agent-config/candidates");
    if (
      response.agent_id !== this.policy.agentId ||
      !Array.isArray(response.results) ||
      response.results.length > 256
    )
      fail(
        "envar_candidate_agent",
        "Platform credential must map to the configured Agent",
      );
    const latest = new Map<string, EnvarCandidate>(),
      seen = new Map<string, string>();
    for (const raw of response.results) {
      const candidate = this.candidate(raw),
        service = candidate.config.services[0]!,
        key = `${service.id}:${service.revision}`;
      if (
        seen.has(key) &&
        seen.get(key) !== `${candidate.id}:${candidate.digest}`
      )
        fail(
          "envar_revision_conflict",
          "The same revision has conflicting candidate digests",
        );
      seen.set(key, `${candidate.id}:${candidate.digest}`);
      const previous = latest.get(service.id);
      if (previous && previous.service_id !== candidate.service_id)
        fail(
          "envar_service_mapping",
          "A local service cannot map to two platform services",
        );
      if (!previous || candidate.revision > previous.revision)
        latest.set(service.id, candidate);
    }
    return [...latest.values()];
  }
  async applyCandidate(
    raw: EnvarCandidate,
    apply: (candidate: EnvarCandidate) => Promise<EnvarApplicationProof>,
  ): Promise<{ ackEventId: string; configPath: string }> {
    this.open();
    if (this.applying)
      fail(
        "envar_busy",
        "Only one configuration application may run at a time",
      );
    const candidate = this.candidate(raw),
      service = candidate.config.services[0]!,
      previous = this.db
        .prepare("SELECT state FROM revisions WHERE id=?")
        .get(candidate.id) as Row | undefined;
    const configPath = join(
      this.configDirectory,
      `${service.id}-v${service.revision}-${candidate.digest}.json`,
    );
    if (previous?.state === "applied") {
      secureFile(configPath);
      if (
        !existsSync(configPath) ||
        digest(JSON.parse(readFileSync(configPath, "utf8"))) !==
          candidate.digest
      )
        fail(
          "envar_config_integrity",
          "The applied configuration file is missing or changed",
        );
      return { ackEventId: this.enqueueAck(candidate), configPath };
    }
    const latest = this.db
      .prepare(
        "SELECT MAX(revision) AS revision FROM revisions WHERE local_service=? AND state='applied'",
      )
      .get(service.id) as Row;
    if (Number(latest.revision ?? 0) > service.revision)
      fail(
        "envar_stale_revision",
        "An older revision cannot replace the active service",
      );
    this.db
      .prepare("INSERT OR IGNORE INTO revisions VALUES (?,?,?,?,?,?,?)")
      .run(
        candidate.id,
        candidate.service_id,
        service.id,
        service.revision,
        candidate.digest,
        JSON.stringify(candidate.config),
        "pending",
      );
    this.applying = true;
    try {
      if (existsSync(configPath)) {
        secureFile(configPath);
        if (
          digest(JSON.parse(readFileSync(configPath, "utf8"))) !==
          candidate.digest
        )
          fail("envar_config_integrity", "The saved candidate changed");
      } else atomicJson(configPath, candidate.config);
      const proof = await apply(structuredClone(candidate));
      if (
        !proof ||
        proof.digest !== candidate.digest ||
        digest(proof.services) !== digest(envarServiceProofs(candidate.config))
      )
        fail(
          "envar_application_proof",
          "Active runtime and stored service revisions did not confirm the candidate",
        );
      atomicJson(
        join(this.configDirectory, `${service.id}-current.json`),
        candidate.config,
      );
      this.db
        .prepare("UPDATE revisions SET state='applied' WHERE id=?")
        .run(candidate.id);
      return { ackEventId: this.enqueueAck(candidate), configPath };
    } finally {
      this.applying = false;
    }
  }
  private enqueueAck(candidate: EnvarCandidate) {
    return this.enqueue(`ack:${candidate.id}:${candidate.digest}`, "ack", {
      revision_id: candidate.id,
      digest: candidate.digest,
    });
  }
  private enqueue(
    key: string,
    kind: "ack" | "report",
    payload: Record<string, unknown>,
  ): string {
    this.open();
    if (!key || key.length > 512 || /[\r\n\0]/.test(key))
      fail("envar_event_key", "Use a stable bounded local event key");
    const fingerprint = digest(payload),
      existing = this.db
        .prepare("SELECT * FROM outbox WHERE dedupe_key=?")
        .get(key) as Row | undefined;
    if (existing) {
      if (existing.kind !== kind || existing.digest !== fingerprint)
        fail(
          "envar_event_conflict",
          "An original event key cannot describe different facts",
        );
      return String(existing.event_id);
    }
    const id = randomUUID(),
      body = { ...payload, event_id: id, source_instance: this.sourceInstance };
    this.db
      .prepare(
        "INSERT INTO outbox (event_id,dedupe_key,kind,payload_json,digest,state) VALUES (?,?,?,?,?,'pending')",
      )
      .run(id, key, kind, JSON.stringify(body), fingerprint);
    return id;
  }
  enqueueStatus(
    dedupeKey: string,
    report: { orderId: string; kind: EnvarStatusKind },
  ): string {
    uuid(report.orderId);
    if (!STATUS_KINDS.includes(report.kind))
      fail("envar_report_kind", "Use an allowed status fact");
    return this.enqueue(`report:${dedupeKey}`, "report", {
      order_id: report.orderId,
      kind: report.kind,
      payload: {},
    });
  }
  enqueueX402Payment(
    dedupeKey: string,
    report: { orderId: string; quote: PriceQuote; payment: EnvarX402Evidence },
  ): string {
    uuid(report.orderId);
    const { quote, payment: p } = report,
      profile = quote.paymentProfile;
    if (
      !profile ||
      profile.adapter !== "x402" ||
      p.network !== profile.network ||
      p.asset.toLowerCase() !== profile.asset.toLowerCase() ||
      p.recipient.toLowerCase() !== profile.payTo.toLowerCase() ||
      p.amount !== quote.amount ||
      quote.currency !== currencyOf(profile) ||
      quote.recipient?.toLowerCase() !== profile.payTo.toLowerCase() ||
      !ADDRESS.test(p.payer) ||
      !HASH.test(p.nonce) ||
      !HASH.test(p.transaction)
    )
      fail(
        "envar_payment_binding",
        "Report the original x402 transaction matching the frozen quote",
      );
    atomic(p.amount);
    return this.enqueue(`report:${dedupeKey}`, "report", {
      order_id: report.orderId,
      kind: "payment_observed",
      payload: {
        protocol: "x402",
        payment: {
          network: p.network,
          asset: p.asset.toLowerCase(),
          payer: p.payer.toLowerCase(),
          recipient: p.recipient.toLowerCase(),
          amount: p.amount,
          nonce: p.nonce.toLowerCase(),
          transaction: p.transaction.toLowerCase(),
        },
      },
    });
  }
  enqueueMppPayment(
    dedupeKey: string,
    report: { orderId: string; quote: PriceQuote; payment: EnvarMppEvidence },
  ): string {
    uuid(report.orderId);
    const { quote, payment: p } = report;
    if (
      quote.paymentProfile?.adapter !== "mpp" ||
      p.amount !== quote.amount ||
      p.currency !== quote.currency ||
      p.currency !== "usd" ||
      !/^pi_[A-Za-z0-9]{1,240}$/.test(p.reference)
    )
      fail(
        "envar_payment_binding",
        "Report the original Stripe PaymentIntent matching the frozen quote",
      );
    atomic(p.amount);
    return this.enqueue(`report:${dedupeKey}`, "report", {
      order_id: report.orderId,
      kind: "payment_observed",
      payload: {
        protocol: "mpp",
        payment: {
          reference: p.reference,
          amount: p.amount,
          currency: p.currency,
        },
      },
    });
  }
  queueStatus(): {
    pending: number;
    sent: number;
    errors: { eventId: string; code: string; attempts: number }[];
  } {
    this.open();
    const count = (state: string) =>
      Number(
        (
          this.db
            .prepare("SELECT COUNT(*) AS count FROM outbox WHERE state=?")
            .get(state) as Row
        ).count,
      );
    return {
      pending: count("pending"),
      sent: count("sent"),
      errors: (
        this.db
          .prepare(
            "SELECT event_id,last_error,attempts FROM outbox WHERE state='pending' AND last_error<>'' ORDER BY rowid LIMIT 100",
          )
          .all() as Row[]
      ).map((r) => ({
        eventId: String(r.event_id),
        code: String(r.last_error),
        attempts: Number(r.attempts),
      })),
    };
  }
  async flush(
    options: { limit?: number } = {},
  ): Promise<{ sent: number; pending: number }> {
    this.open();
    if (this.flushing) return { sent: 0, pending: this.queueStatus().pending };
    const limit = options.limit ?? 16;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      fail("envar_flush_limit", "Flush between one and 100 events");
    this.flushing = true;
    let sent = 0;
    try {
      const rows = this.db
        .prepare(
          "SELECT * FROM outbox WHERE state='pending' AND next_attempt<=? ORDER BY rowid LIMIT ?",
        )
        .all(this.now(), limit) as Row[];
      for (const row of rows) {
        const body = JSON.parse(String(row.payload_json)) as Record<
          string,
          unknown
        >;
        try {
          const response = await this.request(
            row.kind === "ack"
              ? "/api/v1/agent-config/acknowledgments"
              : "/api/v1/commerce-reports",
            body,
            String(row.event_id),
          );
          if (
            row.kind === "ack"
              ? response.id !== body.revision_id ||
                response.digest !== body.digest ||
                !object(response.publication) ||
                response.publication.applied_digest !== body.digest
              : response.accepted !== true
          )
            fail(
              "envar_event_ack",
              "Platform did not acknowledge the original event",
            );
          this.db
            .prepare(
              "UPDATE outbox SET state='sent',last_error='' WHERE event_id=?",
            )
            .run(row.event_id);
          sent++;
        } catch (error) {
          const attempts = Number(row.attempts) + 1,
            code =
              error instanceof CommerceError ? error.code : "envar_transport";
          this.db
            .prepare(
              "UPDATE outbox SET attempts=?,next_attempt=?,last_error=? WHERE event_id=?",
            )
            .run(
              attempts,
              this.now() +
                Math.min(300000, 1000 * 2 ** Math.min(attempts - 1, 9)),
              code,
              row.event_id,
            );
        }
      }
      return { sent, pending: this.queueStatus().pending };
    } finally {
      this.flushing = false;
    }
  }
}
