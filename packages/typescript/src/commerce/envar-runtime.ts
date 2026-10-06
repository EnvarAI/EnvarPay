/** Seller runtime wiring for the optional directory connection; never used by independent purchase paths. */
import {
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
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { digest, loadCommerceConfig } from "./config.js";
import { CommerceError, type CommerceConfig, type Service } from "./types.js";
import { CommerceServer, type ExecuteOrder } from "./server.js";
import { nativeA2AExecutor } from "./upstream.js";
import {
  EnvarIntegration,
  type EnvarCandidate,
  type EnvarApplicationProof,
} from "./envar.js";

function privateJson(path: string): unknown {
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    stat.size > 1024 * 1024
  )
    throw new CommerceError(
      "upstream_binding_file",
      "Use a bounded owner-only upstream binding file",
    );
  return JSON.parse(readFileSync(path, "utf8"));
}
function writePrivate(path: string, value: unknown): void {
  const folder = dirname(path);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const stat = lstatSync(folder);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
    throw new CommerceError(
      "upstream_binding_directory",
      "Use an owner-only runtime state directory",
    );
  if (existsSync(path)) privateJson(path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value), {
      mode: 0o600,
      flag: "wx",
      flush: true,
    });
    renameSync(temporary, path);
    const fd = openSync(folder, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
interface UpstreamBinding {
  cardUrl: string;
  token: string;
  inputEncoding: "data" | "json-text";
}
/** The credential and input encoding for an original revision stay fixed across updates/restarts. */
export class PinnedUpstreams {
  private bindings: Record<string, UpstreamBinding> = {};
  private readonly executors = new Map<string, ExecuteOrder>();
  readonly execute: ExecuteOrder;
  constructor(
    private readonly path: string,
    private readonly credentials: Readonly<Record<string, string>>,
    private readonly inputEncoding: Readonly<
      Record<string, "data" | "json-text">
    > = {},
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly signal?: AbortSignal,
    private readonly skills?: ExecuteOrder,
  ) {
    if (existsSync(path)) {
      const value = privateJson(path) as {
        version?: number;
        bindings?: Record<string, UpstreamBinding>;
      };
      if (
        value.version !== 1 ||
        !value.bindings ||
        typeof value.bindings !== "object" ||
        Array.isArray(value.bindings)
      )
        throw new CommerceError(
          "upstream_bindings",
          "Invalid private upstream binding state",
        );
      for (const [key, binding] of Object.entries(value.bindings))
        if (
          !/^[a-z][a-z0-9-]{0,63}:[1-9][0-9]*$/.test(key) ||
          !binding ||
          typeof binding.cardUrl !== "string" ||
          typeof binding.token !== "string" ||
          binding.token.length < 16 ||
          !["data", "json-text"].includes(binding.inputEncoding)
        )
          throw new CommerceError(
            "upstream_bindings",
            "Invalid private upstream binding state",
          );
      this.bindings = value.bindings;
    }
    const self = this;
    this.execute = async function* (order, service) {
      yield* self.executor(service)(order, service);
    };
    this.execute.continue = async function* (
      order,
      service,
      continuation,
      remote,
    ) {
      yield* self.executor(service).continue!(
        order,
        service,
        continuation,
        remote,
      );
    };
    this.execute.recover = (order, service, remote) =>
      self.executor(service).recover!(order, service, remote);
    this.execute.remoteInterface = (task) => {
      for (const executor of self.executors.values()) {
        const value = executor.remoteInterface?.(task);
        if (value) return value;
      }
      return undefined;
    };
    if (skills) {
      this.execute.assertSkill = (service) => skills.assertSkill!(service);
      this.execute.skillCard = skills.skillCard;
    }
  }
  prepare(config: CommerceConfig, history: readonly Service[] = []): void {
    const next = structuredClone(this.bindings),
      current = new Set(config.services.map((s) => `${s.id}:${s.revision}`));
    for (const service of [...history, ...config.services]) {
      if (service.execution.type === 'skill') {
        if (!this.skills) throw new CommerceError('skill_gate_required', 'Configure the native skill runtime');
        // Retired versions stay readable even after their skill package is upgraded.
        if (current.has(`${service.id}:${service.revision}`)) this.skills.assertSkill!(service);
        continue;
      }
      const key = `${service.id}:${service.revision}`,
        saved = next[key],
        explicit = this.credentials[key];
      if (saved) {
        if (
          saved.cardUrl !== service.execution.cardUrl ||
          (explicit !== undefined && explicit !== saved.token)
        )
          throw new CommerceError(
            "upstream_binding_changed",
            "Original runtime origin/credential differs from its private revision binding",
          );
        continue;
      }
      if (!current.has(key) && !explicit)
        throw new CommerceError(
          "historical_upstream_credentials",
          "Provide an explicit serviceId:revision credential for historical Tasks before first binding migration",
        );
      const token = explicit ?? this.credentials[service.id],
        encoding =
          this.inputEncoding[key] ?? this.inputEncoding[service.id] ?? "data";
      if (
        !token ||
        token.length < 16 ||
        !["data", "json-text"].includes(encoding)
      )
        throw new CommerceError(
          "upstream_credentials",
          "Provide local upstream credentials and explicit input encoding",
        );
      next[key] = {
        cardUrl: service.execution.cardUrl,
        token,
        inputEncoding: encoding,
      };
    }
    writePrivate(resolve(this.path), { version: 1, bindings: next });
    this.bindings = next;
  }
  private executor(service: Service): ExecuteOrder {
    if (service.execution.type === 'skill') {
      if (!this.skills) throw new CommerceError('skill_gate_required', 'Configure the native skill runtime');
      return this.skills;
    }
    const key = `${service.id}:${service.revision}`,
      binding = this.bindings[key];
    if (!binding || binding.cardUrl !== service.execution.cardUrl)
      throw new CommerceError(
        "upstream_binding_missing",
        "Original runtime credential binding is unavailable",
      );
    let executor = this.executors.get(key);
    if (!executor) {
      executor = nativeA2AExecutor(
        { [key]: binding.token },
        this.fetchImpl,
        this.signal,
        { inputEncoding: { [service.id]: binding.inputEncoding } },
      );
      this.executors.set(key, executor);
    }
    return executor;
  }
}

/** Merge a single published service without silently renaming/conflicting shared payment profiles. */
export function mergeEnvarService(
  base: CommerceConfig,
  candidate: EnvarCandidate,
): CommerceConfig {
  const incoming = loadCommerceConfig(candidate.config),
    service = incoming.services[0]!;
  if (incoming.agent.id !== base.agent.id || incoming.services.length !== 1)
    throw new CommerceError(
      "envar_runtime_agent",
      "Candidate does not match this runtime",
    );
  const prior = base.services.find((s) => s.id === service.id);
  if (prior && service.revision < prior.revision)
    throw new CommerceError(
      "envar_stale_revision",
      "An older candidate cannot replace the active service",
    );
  const retained = base.services.filter((s) => s.id !== service.id),
    references = new Set(
      retained.flatMap((s) =>
        s.offers.map((o) => o.paymentProfile).filter((p): p is string => !!p),
      ),
    );
  for (const [key, profile] of Object.entries(incoming.paymentProfiles))
    if (
      references.has(key) &&
      digest(profile) !== digest(base.paymentProfiles[key])
    )
      throw new CommerceError(
        "envar_profile_conflict",
        "Use a unique payment profile ID when its receiving identity differs from another active service",
      );
  const profiles = { ...base.paymentProfiles, ...incoming.paymentProfiles },
    services = [...retained, service],
    used = new Set(
      services.flatMap((s) =>
        s.offers.map((o) => o.paymentProfile).filter((p): p is string => !!p),
      ),
    );
  return loadCommerceConfig({
    ...base,
    configVersion: Math.max(base.configVersion, incoming.configVersion),
    paymentProfiles: Object.fromEntries(
      Object.entries(profiles).filter(([key]) => used.has(key)),
    ),
    services,
  });
}
/** Restore acknowledged local revisions before opening the listener, without a network request. */
export function restoreEnvarConfig(
  base: CommerceConfig,
  integration: EnvarIntegration,
  history: readonly {
    service: Service;
    profiles: CommerceConfig["paymentProfiles"];
  }[] = [],
): CommerceConfig {
  const registered = history.map((snapshot) => ({
    id: snapshot.service.id,
    revision: snapshot.service.revision,
    digest: digest(snapshot),
  }));
  let result = base;
  for (const candidate of [
    ...integration.appliedCandidates(),
    ...integration.pendingCandidates(registered),
  ].sort((a, b) => a.revision - b.revision)) {
    const current = result.services.find(
      (s) => s.id === candidate.config.services[0]!.id,
    );
    if (current && current.revision > candidate.revision) continue;
    result = mergeEnvarService(result, candidate);
  }
  return result;
}
export interface EnvarSellerRuntimeOptions {
  integration: EnvarIntegration;
  server: CommerceServer;
  upstreams: PinnedUpstreams;
  pollIntervalMs?: number;
  /** Local payment adapters/merchant credentials must already exist; config sync cannot create them. */
  validateConfig?: (config: CommerceConfig) => void;
  onError?: (code: string) => void;
  beforeSync?:()=>Promise<void>;
}
export class EnvarSellerRuntime {
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private stopped = false;
  private failures = 0;
  private readonly interval: number;
  constructor(private readonly options: EnvarSellerRuntimeOptions) {
    this.interval = options.pollIntervalMs ?? 10000;
    if (
      !Number.isInteger(this.interval) ||
      this.interval < 1000 ||
      this.interval > 300000
    )
      throw new CommerceError(
        "envar_poll_interval",
        "Poll interval must be between one second and five minutes",
      );
  }
  private async apply(
    candidate: EnvarCandidate,
  ): Promise<EnvarApplicationProof> {
    const config = mergeEnvarService(this.options.server.config, candidate);
    this.options.validateConfig?.(config);
    this.options.upstreams.prepare(
      config,
      this.options.server.store.catalogHistory().map((entry) => entry.service),
    );
    this.options.server.applyConfig(config);
    const expected = candidate.config.services[0]!,
      actual = this.options.server.config.services.find(
        (s) => s.id === expected.id,
      );
    const stored = this.options.server.store
      .catalogHistory()
      .find(
        (entry) =>
          entry.service.id === expected.id &&
          entry.service.revision === expected.revision,
      );
    if (!actual || !stored || digest(actual) !== digest(expected))
      throw new CommerceError(
        "envar_application_proof",
        "Active runtime and persisted service do not match the candidate",
      );
    return {
      digest: candidate.digest,
      services: [
        { id: actual.id, revision: actual.revision, digest: digest(stored) },
      ],
    };
  }
  syncOnce(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) return this.running;
    this.running = (async () => {
      try {
        await this.options.beforeSync?.();
        for (const candidate of await this.options.integration.pullCandidates())
          await this.options.integration.applyCandidate(candidate, (c) =>
            this.apply(c),
          );
      } finally {
        await this.options.integration.flush({ limit: 1 });
      }
    })().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }
  start(): void {
    if (this.timer || this.running || this.stopped) return;
    const tick = async () => {
      try {
        await this.syncOnce();
        this.failures = 0;
      } catch (error) {
        this.failures++;
        this.options.onError?.(
          error instanceof CommerceError ? error.code : "envar_sync_failed",
        );
      } finally {
        if (!this.stopped) {
          this.timer = setTimeout(
            () => {
              this.timer = undefined;
              void tick();
            },
            Math.min(300000, this.interval * 2 ** Math.min(this.failures, 5)),
          );
          this.timer.unref();
        }
      }
    };
    void tick();
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.running?.catch(() => undefined);
  }
}
