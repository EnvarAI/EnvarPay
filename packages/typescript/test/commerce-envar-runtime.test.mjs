import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { Task } from "@a2a-js/sdk";
import { CommerceStore } from "../dist/commerce/store.js";
import {
  CommerceServer,
  bearerAuthenticator,
} from "../dist/commerce/server.js";
import { listenCommerce } from "../dist/commerce/http.js";
import { EnvarIntegration } from "../dist/commerce/envar.js";
import {
  EnvarSellerRuntime,
  PinnedUpstreams,
  restoreEnvarConfig,
  mergeEnvarService,
} from "../dist/commerce/envar-runtime.js";
import { digest, loadCommerceConfig } from "../dist/commerce/config.js";
const clientToken = "a".repeat(40),
  upstreamToken = "upstream-private-token-00000000",
  agentId = randomUUID(),
  platformServiceId = randomUUID();
const sample = () =>
  JSON.parse(
    readFileSync(new URL("../examples/seller.json", import.meta.url), "utf8"),
  );
const freeConfig = () => {
  const c = sample();
  c.services = [c.services[1]];
  c.paymentProfiles = {};
  return loadCommerceConfig(c);
};
const candidate = (config) => ({
  id: randomUUID(),
  service_id: platformServiceId,
  revision: config.services[0].revision,
  config,
  digest: digest(config),
  publication: {
    state: "awaiting_application",
    desired_digest: digest(config),
  },
});
function req(origin, path, method, params) {
  return new Request(origin + path + "/a2a", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + clientToken,
      "A2A-Version": "1.0",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params }),
  });
}
async function idle(server) {
  while (server.isRunning) await new Promise((r) => setTimeout(r, 2));
}
const message = (id, input) => ({
  message: { messageId: id, role: "ROLE_USER", parts: [{ data: input }] },
  configuration: { returnImmediately: true },
});
async function closeServer(server, store) {
  server.stop();
  await idle(server);
  store.close();
}

test("running HTTP handler applies revised Cards and preserves original free/paid Task reads", async () => {
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = socket.address().port;
  await new Promise((r) => socket.close(r));
  const origin = `http://127.0.0.1:${port}`;
  const store = new CommerceStore(":memory:"),
    config = loadCommerceConfig(sample());
  let executions = 0,
    settlements = 0;
  const server = new CommerceServer({
    config,
    origin,
    store,
    authenticate: bearerAuthenticator({ [clientToken]: "buyer" }),
    execute: async function* (order, service) {
      executions++;
      yield Task.fromJSON({
        id: "remote-" + order.id,
        status: { state: "TASK_STATE_COMPLETED" },
        artifacts: [
          {
            artifactId: "report",
            parts: [{ text: "revision " + service.revision }],
          },
        ],
      });
    },
    paymentGate: {
      handle: async (_request, order) => {
        if (order.paymentState !== "confirmed") {
          settlements++;
          const attempt = store.reservePayment(
            order.id,
            order.caller,
            "simulated:" + order.id,
            "simulated-vault-ref",
          );
          store.recordSettlement(attempt, "confirmed", { simulated: true });
        }
        return { headers: {} };
      },
    },
  });
  const http = listenCommerce(server, origin, "127.0.0.1", port);
  await once(http, "listening");
  try {
    const freePath = "/services/summary-preview/v1/offers/free",
      paidPath = "/services/research/v1/offers/usdc-once";
    const free = await (
      await fetch(
        req(
          origin,
          freePath,
          "SendMessage",
          message("original-free", { text: "hello" }),
        ),
      )
    ).json();
    const paid = await (
      await fetch(
        req(
          origin,
          paidPath,
          "SendMessage",
          message("original-paid", { topic: "agents", competitors: ["A"] }),
        ),
      )
    ).json();
    await idle(server);
    const next = structuredClone(config);
    next.services[0].revision = 2;
    next.services[0].offers[0].pricing.amount = "4000000";
    next.services[1].revision = 2;
    next.services[1].name = "Preview revision two";
    server.applyConfig(next);
    const card = await (
      await fetch(
        origin + "/services/summary-preview/v2/offers/free/agent-card.json",
      )
    ).json();
    assert.equal(card.name, "Preview revision two");
    for (const [path, id] of [
      [freePath, free.result.task.id],
      [paidPath, paid.result.task.id],
    ]) {
      const result = await (
        await fetch(req(origin, path, "GetTask", { id }))
      ).json();
      assert.equal(result.result.id, id);
      assert.equal(result.result.status.state, "TASK_STATE_COMPLETED");
      assert.equal(result.result.artifacts[0].parts[0].text, "revision 1");
    }
    const retired = await (
      await fetch(
        req(
          origin,
          paidPath,
          "SendMessage",
          message("new-at-retired-url", {
            topic: "agents",
            competitors: ["B"],
          }),
        ),
      )
    ).json();
    assert.ok(retired.error);
    assert.equal(settlements, 1);
    assert.equal(executions, 2);
    const rejected = structuredClone(next);
    rejected.services[0].offers[0].pricing.amount = "5000000";
    assert.throws(() => server.applyConfig(rejected), {
      code: "immutable_revision",
    });
    assert.equal(server.config.services[0].offers[0].pricing.amount, "4000000");
  } finally {
    server.stop();
    await new Promise((r) => http.close(r));
    await idle(server);
    store.close();
  }
});

test("unknown Task on retired revision recovers using its original execution service", async () => {
  const store = new CommerceStore(":memory:"),
    config = freeConfig(),
    origin = "http://seller.example";
  let dispatches = 0,
    recovered = 0;
  const execute = async function* () {
    dispatches++;
    yield Task.fromJSON({
      id: "original-remote",
      status: { state: "TASK_STATE_WORKING" },
    });
    throw new Error("network lost");
  };
  execute.recover = async (_order, service, remote) => {
    recovered++;
    assert.equal(service.revision, 1);
    assert.equal(remote.taskId, "original-remote");
    return Task.fromJSON({
      id: remote.taskId,
      status: { state: "TASK_STATE_COMPLETED" },
    });
  };
  const server = new CommerceServer({
    config,
    origin,
    store,
    authenticate: bearerAuthenticator({ [clientToken]: "buyer" }),
    execute,
  });
  try {
    const body = await (
      await server.handle(
        req(
          origin,
          "/services/summary-preview/v1/offers/free",
          "SendMessage",
          message("original", { text: "hello" }),
        ),
      )
    ).json();
    await idle(server);
    const next = structuredClone(config);
    next.services[0].revision = 2;
    server.applyConfig(next);
    const read = await (
      await server.handle(
        req(origin, "/services/summary-preview/v1/offers/free", "GetTask", {
          id: body.result.task.id,
        }),
      )
    ).json();
    assert.equal(read.result.status.state, "TASK_STATE_COMPLETED");
    assert.equal(dispatches, 1);
    assert.equal(recovered, 1);
  } finally {
    await closeServer(server, store);
  }
});

function syncFixture({ rejectApply = false, failAck = false, dir } = {}) {
  const root = dir ?? mkdtempSync(join(tmpdir(), "envar-runtime-")),
    config = freeConfig(),
    next = structuredClone(config);
  next.services[0].revision = 2;
  next.services[0].name = "Applied through Envar";
  const current = candidate(next),
    calls = [];
  let reject = rejectApply,
    ackFailure = failAck;
  const opts = {
    policy: {
      enabled: true,
      platformOrigin: "https://envar.example",
      agentId,
      runtimeAgentId: config.agent.id,
      acceptUpdates: true,
      allowedServices: ["summary-preview"],
      allowedUpstreamOrigins: ["http://hermes:9000"],
      allowedX402: [],
      allowedMppAccounts: [],
    },
    stateDirectory: join(root, "integration"),
    configDirectory: join(root, "configs"),
    token: () => clientToken,
    now: () => 2000,
    fetch: async (url, init) => {
      calls.push({ url, body: init.body ? JSON.parse(init.body) : undefined });
      if (url.endsWith("/candidates"))
        return Response.json({ agent_id: agentId, results: [current] });
      if (ackFailure) return new Response("", { status: 503 });
      const body = JSON.parse(init.body);
      return Response.json({
        id: body.revision_id,
        digest: body.digest,
        publication: { applied_digest: body.digest },
      });
    },
  };
  const integration = new EnvarIntegration(opts),
    store = new CommerceStore(join(root, "runtime.sqlite")),
    upstreams = new PinnedUpstreams(join(root, "upstreams.json"), {
      "summary-preview": upstreamToken,
    });
  upstreams.prepare(config);
  const server = new CommerceServer({
    config,
    origin: "http://seller.example",
    store,
    authenticate: bearerAuthenticator({ [clientToken]: "buyer" }),
    execute: upstreams.execute,
  });
  const runtime = new EnvarSellerRuntime({
    integration,
    server,
    upstreams,
    validateConfig: () => {
      if (reject) throw new Error("adapter not ready");
    },
  });
  return {
    root,
    config,
    next,
    current,
    calls,
    opts,
    integration,
    store,
    server,
    runtime,
    setReject: (v) => (reject = v),
    setAckFailure: (v) => (ackFailure = v),
    async close() {
      await runtime.stop();
      await closeServer(server, store);
      integration.close();
      if (!dir) rmSync(root, { recursive: true, force: true });
    },
  };
}
test("config pull applies active handler before ack and application failure never acknowledges", async () => {
  const f = syncFixture({ rejectApply: true });
  try {
    await assert.rejects(f.runtime.syncOnce());
    assert.equal(f.integration.queueStatus().pending, 0);
    assert.equal(f.calls.length, 1);
    assert.equal(f.server.config.services[0].revision, 1);
    f.setReject(false);
    await f.runtime.syncOnce();
    assert.equal(f.server.config.services[0].revision, 2);
    assert.equal(f.integration.queueStatus().sent, 1);
    const card = await (
      await f.server.handle(
        new Request(
          "http://seller.example/services/summary-preview/v2/offers/free/agent-card.json",
        ),
      )
    ).json();
    assert.equal(card.name, "Applied through Envar");
    assert.equal(f.calls.at(-1).body.digest, digest(f.next));
  } finally {
    await f.close();
  }
});
test("restart restores acknowledged config without network and retries original pending ack", async () => {
  const dir = mkdtempSync(join(tmpdir(), "envar-runtime-restart-")),
    f = syncFixture({ failAck: true, dir });
  await f.runtime.syncOnce();
  const original = f.calls.at(-1).body.event_id;
  assert.equal(f.integration.queueStatus().pending, 1);
  await f.close();
  let calls = 0;
  const integration = new EnvarIntegration({
    ...f.opts,
    now: () => 10000,
    fetch: async (_url, init) => {
      calls++;
      const body = JSON.parse(init.body);
      assert.equal(body.event_id, original);
      return Response.json({
        id: body.revision_id,
        digest: body.digest,
        publication: { applied_digest: body.digest },
      });
    },
  });
  try {
    const restored = restoreEnvarConfig(f.config, integration);
    assert.equal(restored.services[0].revision, 2);
    assert.equal(calls, 0);
    await integration.flush();
    assert.equal(calls, 1);
    assert.equal(integration.queueStatus().sent, 1);
  } finally {
    integration.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("upstream revision credentials persist independently of later base-token changes", () => {
  const dir = mkdtempSync(join(tmpdir(), "envar-upstream-binding-")),
    config = freeConfig(),
    path = join(dir, "bindings.json");
  try {
    const initial = new PinnedUpstreams(path, {
      "summary-preview": upstreamToken,
    });
    initial.prepare(config);
    const next = structuredClone(config);
    next.services[0].revision = 2;
    const changed = "new-private-token-for-revision-2";
    const restart = new PinnedUpstreams(path, { "summary-preview": changed });
    restart.prepare(next, config.services);
    const data = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(data.bindings["summary-preview:1"].token, upstreamToken);
    assert.equal(data.bindings["summary-preview:2"].token, changed);
    const malicious = new PinnedUpstreams(path, {
      "summary-preview:1": changed,
    });
    assert.throws(() => malicious.prepare(config), {
      code: "upstream_binding_changed",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("merge refuses payment profile collisions across active services", () => {
  const base = loadCommerceConfig(sample()),
    incoming = structuredClone(base);
  incoming.services = [incoming.services[0]];
  incoming.services[0].revision = 2;
  incoming.paymentProfiles["base-usdc"].payTo = "0x" + "8".repeat(40);
  assert.throws(() => mergeEnvarService(base, candidate(incoming)), {
    code: "envar_profile_conflict",
  });
});
test("standalone CLI still starts a free seller with no Envar token or paid credentials", async () => {
  const dir = mkdtempSync(join(tmpdir(), "envar-cli-"));
  const reserve = createServer();
  reserve.listen(0, "127.0.0.1");
  await once(reserve, "listening");
  const port = reserve.address().port;
  await new Promise((r) => reserve.close(r));
  writeFileSync(join(dir, "seller.json"), JSON.stringify(freeConfig()), {
    mode: 0o600,
  });
  writeFileSync(
    join(dir, "credentials.json"),
    JSON.stringify({
      callers: { [clientToken]: "buyer" },
      upstreams: { "summary-preview": upstreamToken },
    }),
    { mode: 0o600 },
  );
  const child = spawn(
    process.execPath,
    [
      new URL("../dist/commerce/cli.js", import.meta.url).pathname,
      "serve",
      "--config",
      join(dir, "seller.json"),
      "--credentials",
      join(dir, "credentials.json"),
      "--state",
      join(dir, "runtime.sqlite"),
      "--origin",
      `http://127.0.0.1:${port}`,
      "--port",
      String(port),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk.toString()));
  try {
    const until = Date.now() + 10000;
    while (
      !output.includes("listening") &&
      child.exitCode === null &&
      Date.now() < until
    )
      await new Promise((r) => setTimeout(r, 20));
    assert.ok(output.includes("listening"));
    assert.equal(
      (
        await fetch(
          `http://127.0.0.1:${port}/services/summary-preview/v1/offers/free/agent-card.json`,
        )
      ).status,
      200,
    );
    child.kill("SIGTERM");
    const [code] = await once(child, "exit");
    assert.equal(code, 0);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("crash window after durable catalog apply but before acknowledgment restores the same candidate", async () => {
  const dir = mkdtempSync(join(tmpdir(), "envar-runtime-crash-")),
    f = syncFixture({ dir });
  await assert.rejects(
    f.integration.applyCandidate(f.current, async (accepted) => {
      f.server.applyConfig(accepted.config);
      throw new Error("simulated process death before proof");
    }),
  );
  assert.equal(f.integration.queueStatus().pending, 0);
  await f.close();
  const integration = new EnvarIntegration(f.opts),
    store = new CommerceStore(join(dir, "runtime.sqlite"));
  try {
    const restored = restoreEnvarConfig(
      f.config,
      integration,
      store.catalogHistory(),
    );
    assert.equal(restored.services[0].revision, 2);
    const server = new CommerceServer({
      config: restored,
      origin: "http://seller.example",
      store,
      authenticate: bearerAuthenticator({ [clientToken]: "buyer" }),
      execute: async function* () {
        throw new Error("must not execute during startup");
      },
    });
    const card = await (
      await server.handle(
        new Request(
          "http://seller.example/services/summary-preview/v2/offers/free/agent-card.json",
        ),
      )
    ).json();
    assert.equal(card.name, "Applied through Envar");
    server.stop();
    await idle(server);
  } finally {
    store.close();
    integration.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("free and MPP-only buyer CLI starts without an EVM key or RPC", async () => {
  for (const protocol of ["free", "mpp"]) {
    const dir = mkdtempSync(join(tmpdir(), "envar-cli-buyer-")),
      reserve = createServer();
    reserve.listen(0, "127.0.0.1");
    await once(reserve, "listening");
    const port = reserve.address().port;
    await new Promise((r) => reserve.close(r));
    const policy = {
      policyVersion: 1,
      paymentsEnabled: protocol === "mpp",
      approval: "per_purchase",
      peers: [
        {
          id: "peer",
          cardUrl: `https://seller.example/services/test/v1/offers/${protocol}/agent-card.json`,
          protocol,
          currency: protocol === "free" ? null : "usd",
          recipient: protocol === "free" ? null : "profile_test",
          maxPerPurchase: protocol === "free" ? "0" : "100",
        },
      ],
      budgets:
        protocol === "free"
          ? []
          : [{ currency: "usd", maxTotal: "100", period: "cumulative" }],
    };
    const credentials = {
      callers: { [clientToken]: "owner" },
      peerTokens: { peer: upstreamToken },
      vaultKeyFile: join(dir, "vault.key"),
    };
    if (protocol === "mpp") {
      credentials.mppAdapterModule = join(dir, "mpp.mjs");
      writeFileSync(
        credentials.mppAdapterModule,
        "export function createMppBuyerOptions(){return {payer:'test-payer',mode:'test',paymentMethod:'pm_test',createToken:async()=>{throw new Error('test must never create payment')},recoverToken:async()=>undefined,verifyReceipt:async()=>false}}",
        { mode: 0o600 },
      );
    }
    writeFileSync(join(dir, "policy.json"), JSON.stringify(policy), {
      mode: 0o600,
    });
    writeFileSync(join(dir, "credentials.json"), JSON.stringify(credentials), {
      mode: 0o600,
    });
    writeFileSync(join(dir, "vault.key"), Buffer.alloc(32, 7), { mode: 0o600 });
    const child = spawn(
      process.execPath,
      [
        new URL("../dist/commerce/cli.js", import.meta.url).pathname,
        "buyer-serve",
        "--config",
        join(dir, "policy.json"),
        "--credentials",
        join(dir, "credentials.json"),
        "--state",
        join(dir, "buyer.sqlite"),
        "--origin",
        `http://127.0.0.1:${port}`,
        "--port",
        String(port),
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk.toString()));
    try {
      const deadline = Date.now() + 10000;
      while (
        !output.includes("listening") &&
        child.exitCode === null &&
        Date.now() < deadline
      )
        await new Promise((r) => setTimeout(r, 20));
      assert.ok(output.includes("listening"));
      const response = await fetch(
        `http://127.0.0.1:${port}/management/v1/policy`,
        { headers: { Authorization: "Bearer " + clientToken } },
      );
      assert.equal(response.status, 200);
      assert.deepEqual((await response.json()).capabilities, [protocol]);
      child.kill("SIGTERM");
      const [code] = await once(child, "exit");
      assert.equal(code, 0);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
