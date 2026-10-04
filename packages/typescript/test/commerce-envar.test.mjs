import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  EnvarIntegration,
  envarServiceProofs,
} from "../dist/commerce/envar.js";
import {
  loadCommerceConfig,
  digest,
  currencyOf,
} from "../dist/commerce/config.js";
import { CommerceStore } from "../dist/commerce/store.js";
const token = "runtime-token-never-in-reports-".repeat(2),
  agentId = randomUUID(),
  serviceId = randomUUID(),
  orderId = randomUUID();
function candidate() {
  const config = JSON.parse(
    readFileSync(new URL("../examples/seller.json", import.meta.url), "utf8"),
  );
  config.services = config.services.slice(0, 1);
  loadCommerceConfig(config);
  const fingerprint = digest(config);
  return {
    id: randomUUID(),
    service_id: serviceId,
    revision: 1,
    config,
    digest: fingerprint,
    publication: { state: "awaiting_application", desired_digest: fingerprint },
  };
}
function reseal(c) {
  c.digest = digest(c.config);
  c.publication.desired_digest = c.digest;
  return c;
}
function fixture(options = {}) {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), "envar-integration-")),
    calls = [],
    current = candidate();
  let clock = 0;
  const policy = {
    enabled: true,
    platformOrigin: "https://envar.example",
    agentId,
    runtimeAgentId: current.config.agent.id,
    acceptUpdates: true,
    allowedServices: ["research"],
    allowedUpstreamOrigins: ["http://hermes:9000"],
    allowedX402: [
      {
        network: "eip155:84532",
        asset: current.config.paymentProfiles["base-usdc"].asset,
        payTo: current.config.paymentProfiles["base-usdc"].payTo,
        facilitatorOrigin: "https://facilitator.example",
      },
    ],
    allowedMppAccounts: ["seller-stripe"],
    ...options.policy,
  };
  const fetcher = async (url, init) => {
    calls.push({
      url,
      init,
      body: init.body ? JSON.parse(init.body) : undefined,
    });
    if (options.fetch) return options.fetch(url, init);
    if (url.endsWith("/candidates"))
      return Response.json({ agent_id: agentId, results: [current] });
    const body = JSON.parse(init.body);
    if (url.endsWith("/acknowledgments"))
      return Response.json({
        id: body.revision_id,
        digest: body.digest,
        publication: { applied_digest: body.digest },
      });
    return Response.json({ accepted: true });
  };
  const init = {
    policy,
    stateDirectory: join(dir, "state"),
    configDirectory: join(dir, "config"),
    token: () => token,
    fetch: fetcher,
    now: () => clock,
    ...options.init,
  };
  const integration = new EnvarIntegration(init);
  return {
    dir,
    calls,
    current,
    init,
    integration,
    advance: (n) => {
      clock += n;
    },
    close() {
      integration.close();
      if (!options.dir) rmSync(dir, { recursive: true, force: true });
    },
  };
}
const proof = async (c) => ({
  digest: c.digest,
  services: envarServiceProofs(c.config),
});

test("optional connection requires local opt-in and never pulls updates without permission", async () => {
  const f = fixture({ policy: { acceptUpdates: false } });
  try {
    assert.deepEqual(await f.integration.pullCandidates(), []);
    assert.equal(f.calls.length, 0);
    await assert.rejects(f.integration.applyCandidate(f.current, proof), {
      code: "envar_updates_disabled",
    });
  } finally {
    f.close();
  }
  assert.throws(() => new EnvarIntegration({ policy: { enabled: false } }), {
    code: "envar_not_enabled",
  });
});
test("exact platform origin, mapped Agent and JCS digest are checked before application", async () => {
  for (const mutate of [
    (c) => {
      c.digest = "0".repeat(64);
    },
    (c) => {
      c.config.services[0].execution.cardUrl = "http://other:9000/card";
      reseal(c);
    },
    (c) => {
      c.config.paymentProfiles["base-usdc"].payTo = "0x" + "9".repeat(40);
      reseal(c);
    },
    (c) => {
      c.config.paymentProfiles["stripe-usd"].accountRef = "other";
      reseal(c);
    },
  ]) {
    const f = fixture();
    try {
      mutate(f.current);
      await assert.rejects(f.integration.pullCandidates());
      assert.equal(f.integration.queueStatus().pending, 0);
    } finally {
      f.close();
    }
  }
  const wrong = fixture({
    fetch: async () => Response.json({ agent_id: randomUUID(), results: [] }),
  });
  try {
    await assert.rejects(wrong.integration.pullCandidates(), {
      code: "envar_candidate_agent",
    });
  } finally {
    wrong.close();
  }
});
test("HTTP redirects never receive a second credential-bearing request", async () => {
  const f = fixture({
    fetch: async () =>
      new Response("", {
        status: 302,
        headers: { location: "https://attacker.example" },
      }),
  });
  try {
    await assert.rejects(f.integration.pullCandidates(), {
      code: "envar_redirect",
    });
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].init.redirect, "error");
    assert.equal(f.calls[0].init.credentials, "omit");
    assert.equal(new URL(f.calls[0].url).origin, "https://envar.example");
  } finally {
    f.close();
  }
});
test("response limits apply to streamed bodies without a content-length header", async () => {
  const f = fixture({
    init: { responseLimitBytes: 1024 },
    fetch: async () => new Response("a".repeat(2048)),
  });
  try {
    await assert.rejects(f.integration.pullCandidates(), {
      code: "envar_response_size",
    });
  } finally {
    f.close();
  }
});
test("ack is queued only after actual catalog persistence and matching application proof", async () => {
  const f = fixture(),
    store = new CommerceStore(join(f.dir, "runtime.sqlite"));
  try {
    const [c] = await f.integration.pullCandidates();
    await assert.rejects(
      f.integration.applyCandidate(c, async () => {
        throw new Error("application failed");
      }),
    );
    assert.equal(f.integration.queueStatus().pending, 0);
    await assert.rejects(
      f.integration.applyCandidate(c, async () => ({
        digest: c.digest,
        services: [],
      })),
      { code: "envar_application_proof" },
    );
    assert.equal(f.integration.queueStatus().pending, 0);
    const result = await f.integration.applyCandidate(c, async (accepted) => {
      store.registerCatalog(accepted.config);
      return {
        digest: accepted.digest,
        services: store
          .catalogHistory()
          .map((s) => ({
            id: s.service.id,
            revision: s.service.revision,
            digest: digest(s),
          })),
      };
    });
    assert.equal(statSync(result.configPath).mode & 0o777, 0o600);
    assert.equal(
      digest(JSON.parse(readFileSync(result.configPath, "utf8"))),
      c.digest,
    );
    assert.equal(f.calls.length, 1);
    await f.integration.flush();
    const ack = f.calls.at(-1);
    assert.equal(ack.body.digest, c.digest);
    assert.equal(ack.body.event_id, result.ackEventId);
    assert.equal(ack.init.headers["Idempotency-Key"], result.ackEventId);
    let reapplied = false;
    await f.integration.applyCandidate(c, async () => {
      reapplied = true;
      return proof(c);
    });
    assert.equal(reapplied, false);
    assert.equal(f.integration.queueStatus().sent, 1);
  } finally {
    store.close();
    f.close();
  }
});
test("historical price conflicts and older revisions cannot replace a newer service", async () => {
  const f = fixture();
  try {
    await f.integration.applyCandidate(f.current, proof);
    const changed = structuredClone(f.current);
    changed.config.services[0].offers[0].pricing.amount = "4000000";
    reseal(changed);
    await assert.rejects(f.integration.applyCandidate(changed, proof), {
      code: "envar_revision_conflict",
    });
    const next = structuredClone(f.current);
    next.id = randomUUID();
    next.revision = 3;
    next.config.services[0].revision = 3;
    reseal(next);
    await f.integration.applyCandidate(next, proof);
    const middle = structuredClone(next);
    middle.id = randomUUID();
    middle.revision = 2;
    middle.config.services[0].revision = 2;
    reseal(middle);
    await assert.rejects(f.integration.applyCandidate(middle, proof), {
      code: "envar_stale_revision",
    });
  } finally {
    f.close();
  }
});
test("source identity, queued event IDs and retries survive restart without duplicate reports", async () => {
  const dir = mkdtempSync(join(tmpdir(), "envar-restart-"));
  let attempts = 0;
  const bodies = [];
  const f = fixture({
    dir,
    fetch: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      attempts++;
      return attempts === 1
        ? new Response("", { status: 503 })
        : Response.json({ accepted: true });
    },
  });
  const event = f.integration.enqueueStatus("original-task:completed", {
      orderId,
      kind: "seller_completed",
    }),
    source = f.integration.sourceInstance;
  await f.integration.flush();
  assert.equal(f.integration.queueStatus().pending, 1);
  f.integration.close();
  const restarted = new EnvarIntegration({ ...f.init, now: () => 2000 });
  try {
    assert.equal(restarted.sourceInstance, source);
    assert.equal(
      restarted.enqueueStatus("original-task:completed", {
        orderId,
        kind: "seller_completed",
      }),
      event,
    );
    await restarted.flush();
    assert.equal(restarted.queueStatus().sent, 1);
    assert.deepEqual(bodies[1], bodies[0]);
    assert.equal(bodies[0].event_id, event);
    assert.throws(
      () =>
        restarted.enqueueStatus("original-task:completed", {
          orderId,
          kind: "seller_failed",
        }),
      { code: "envar_event_conflict" },
    );
  } finally {
    restarted.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("only minimal original payment facts are queued; signatures, SPTs and prompts are excluded", async () => {
  const f = fixture();
  try {
    const x = f.current.config.paymentProfiles["base-usdc"],
      quote = {
        amount: "3000000",
        currency: currencyOf(x),
        recipient: x.payTo,
        paymentProfile: x,
      };
    const payment = {
      network: x.network,
      asset: x.asset,
      payer: "0x" + "1".repeat(40),
      recipient: x.payTo,
      amount: "3000000",
      nonce: "0x" + "3".repeat(64),
      transaction: "0x" + "4".repeat(64),
      signature: "never-leak-signature",
      prompt: "private-prompt",
    };
    f.integration.enqueueX402Payment("original:receipt", {
      orderId,
      quote,
      payment,
    });
    assert.throws(
      () =>
        f.integration.enqueueX402Payment("bad", {
          orderId,
          quote,
          payment: { ...payment, amount: "1" },
        }),
      { code: "envar_payment_binding" },
    );
    const m = f.current.config.paymentProfiles["stripe-usd"];
    f.integration.enqueueMppPayment("stripe:receipt", {
      orderId,
      quote: { amount: "300", currency: "usd", paymentProfile: m },
      payment: {
        reference: "pi_123abc",
        amount: "300",
        currency: "usd",
        spt: "never-leak-spt",
      },
    });
    await f.integration.flush();
    const serialized = JSON.stringify(f.calls.map((c) => c.body));
    for (const secret of [
      token,
      "never-leak-signature",
      "never-leak-spt",
      "private-prompt",
    ])
      assert.equal(serialized.includes(secret), false);
    assert.deepEqual(Object.keys(f.calls[0].body.payload.payment).sort(), [
      "amount",
      "asset",
      "network",
      "nonce",
      "payer",
      "recipient",
      "transaction",
    ]);
  } finally {
    f.close();
  }
});
test("concurrent ownership and platform identity swaps fail closed", () => {
  const f = fixture();
  try {
    assert.throws(() => new EnvarIntegration(f.init), {
      code: "envar_integration_owned",
    });
    f.integration.close();
    assert.throws(
      () =>
        new EnvarIntegration({
          ...f.init,
          policy: { ...f.init.policy, platformOrigin: "https://other.example" },
        }),
      { code: "envar_state_binding" },
    );
  } finally {
    f.close();
  }
});
test("saved applied configuration corruption cannot produce a fresh acknowledgment", async () => {
  const f = fixture();
  try {
    const result = await f.integration.applyCandidate(f.current, proof);
    writeFileSync(result.configPath, "{}");
    await assert.rejects(f.integration.applyCandidate(f.current, proof), {
      code: "envar_config_integrity",
    });
  } finally {
    f.close();
  }
});
