import { request as httpRequest } from "node:http";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { randomUUID, createHmac } from "node:crypto";
import {
  setupExternalAgent,
  serveExternalAgent,
} from "../dist/commerce/external-runtime.js";
import { ExternalAgentEvents } from "../dist/commerce/external-events.js";
import { ExternalAgentExecutor } from "../dist/commerce/external-agent.js";
import { CredentialVault } from "../dist/commerce/vault.js";
const root = () => mkdtempSync(join(tmpdir(), "envar-external-"));
test("original free Task is claimed, completed and replayed once; scopes and terminal output survive restart", async () => {
  const d = root();
  const origin = "https://external.example";
  setupExternalAgent(d, origin);
  const secret = JSON.parse(readFileSync(join(d, "credentials.json"))),
    buyer = readFileSync(join(d, "buyer.token"), "utf8"),
    agent = readFileSync(join(d, "agent.token"), "utf8");
  let r = serveExternalAgent({
    configFile: join(d, "seller.json"),
    credentialsFile: join(d, "credentials.json"),
    stateFile: join(d, "seller.sqlite3"),
    origin,
    host: "127.0.0.1",
    port: 0,
  });
  await once(r.http, "listening");
  const request = (path, method, params, token) =>
    new Request(origin + path, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "A2A-Version": "1.0",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: randomUUID(),
        method,
        params,
      }),
    });
  const rpc = async (method, params) => {
    const response = await r.server.handle(
      request(
        "/services/text-answer/v1/offers/free/a2a",
        method,
        params,
        buyer,
      ),
    );
    const text = await response.text();
    assert.ok(text, "A2A " + method + " empty " + response.status);
    return JSON.parse(text);
  };
  const mcp = async (method, params, token = agent) =>
    new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port: r.http.address().port,
          path: "/mcp",
          method: "POST",
          headers: {
            Host: "external.example",
            Authorization: "Bearer " + token,
            "Content-Type": "application/json",
            Accept: "application/json,text/event-stream",
            "MCP-Protocol-Version": "2026-07-28",
          },
        },
        (res) => {
          let text = "";
          res.on("data", (x) => (text += x));
          res.on("end", () => {
            try {
              assert.ok(text, "MCP " + method + " empty " + res.statusCode);
              resolve({ status: res.statusCode, body: JSON.parse(text) });
            } catch (e) {
              reject(e);
            }
          });
        },
      );
      req.on("error", reject);
      req.end(
        JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params }),
      );
    });
  try {
    const params = {
      message: {
        messageId: "request-once",
        role: "ROLE_USER",
        parts: [{ data: { request: "A harmless text request" } }],
      },
      configuration: { returnImmediately: true },
    };
    const sent = await rpc("SendMessage", params);
    const id = sent.result.task.id;
    while (r.server.isRunning) await new Promise((z) => setTimeout(z, 1));
    assert.equal((await mcp("tools/list", {})).status, 200);
    assert.equal((await mcp("tools/list", {}, buyer)).status, 401);
    const discovery = await mcp("server/discover", {});
    assert.ok(discovery.body.result.capabilities.events);
    const skill = await mcp("skills/list", {});
    assert.match(skill.body.result.skills[0].resources[0].digest, /^sha256:/);
    assert.deepEqual(
      (await mcp("skills/get", { uri: skill.body.result.skills[0].uri })).body
        .result.skill,
      skill.body.result.skills[0],
    );
    const initialized = await mcp("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "acceptance", version: "1" },
    });
    assert.ok(
      initialized.body.result.capabilities.extensions[
        "io.modelcontextprotocol/skills"
      ],
    );
    const claim = await mcp("tools/call", {
      name: "claim_task",
      arguments: { taskId: id },
    });
    assert.ok(claim.body.result, JSON.stringify(claim.body));
    const c = JSON.parse(claim.body.result.content[0].text);
    assert.equal(c.taskId, id);
    assert.equal(c.paymentState, "not_required");
    const repeat = JSON.parse(
      (
        await mcp("tools/call", {
          name: "claim_task",
          arguments: { taskId: id },
        })
      ).body.result.content[0].text,
    );
    assert.equal(repeat.claimId, c.claimId);
    const concurrentParams = structuredClone(params);
    concurrentParams.message.messageId = "concurrent-result";
    const concurrentId = (await rpc("SendMessage", concurrentParams)).result
      .task.id;
    while (r.server.isRunning) await new Promise((z) => setTimeout(z, 1));
    const executor = new ExternalAgentExecutor(r.store, "external-agent", [
      "text-answer",
    ]);
    const concurrentClaim = await executor.claim(concurrentId);
    const results = await Promise.allSettled([
      executor.complete(concurrentId, concurrentClaim.claimId, "First result"),
      executor.complete(concurrentId, concurrentClaim.claimId, "Second result"),
    ]);
    assert.equal(results.filter((v) => v.status === "fulfilled").length, 1);
    assert.equal(results.filter((v) => v.status === "rejected").length, 1);
    const invalid = await mcp("tools/call", {
      name: "complete_task",
      arguments: { taskId: id, claimId: randomUUID(), text: "invalid" },
    });
    assert.equal(invalid.body.result.isError, true);
    await mcp("tools/call", {
      name: "complete_task",
      arguments: {
        taskId: id,
        claimId: c.claimId,
        text: "Actual external result",
      },
    });
    const done = await rpc("GetTask", { id });
    assert.equal(done.result.status.state, "TASK_STATE_COMPLETED");
    assert.equal((await rpc("SendMessage", params)).result.task.id, id);
    const conflict = await mcp("tools/call", {
      name: "complete_task",
      arguments: { taskId: id, claimId: c.claimId, text: "Replacement result" },
    });
    assert.equal(conflict.body.result.isError, true);
    const same = await mcp("tools/call", {
      name: "complete_task",
      arguments: {
        taskId: id,
        claimId: c.claimId,
        text: "Actual external result",
      },
    });
    assert.ok(!same.body.result.isError);
    await r.close();
    r = serveExternalAgent({
      configFile: join(d, "seller.json"),
      credentialsFile: join(d, "credentials.json"),
      stateFile: join(d, "seller.sqlite3"),
      origin,
      host: "127.0.0.1",
      port: 0,
    });
    await once(r.http, "listening");
    assert.equal(
      (await rpc("GetTask", { id })).result.status.state,
      "TASK_STATE_COMPLETED",
    );
    assert.equal((await rpc("SendMessage", params)).result.task.id, id);
    assert.equal(secret.principal, "external-agent");
  } finally {
    await r.close();
    rmSync(d, { recursive: true, force: true });
  }
});
test("event subscription verifies signed callback; duplicate delivery, unsubscribe and scope are bounded", async () => {
  const d = root(),
    calls = [];
  let tasks = [];
  const principal = "agent-one",
    key = Buffer.alloc(32, 7),
    secret = "whsec_" + key.toString("base64");
  const webhook = async (url, body, headers) => {
    assert.equal(url, "https://receiver.example/mcp-events/abc");
    const sig = createHmac("sha256", key)
      .update(
        headers["webhook-id"] + "." + headers["webhook-timestamp"] + "." + body,
      )
      .digest("base64");
    assert.equal(headers["webhook-signature"], "v1," + sig);
    const value = JSON.parse(body);
    calls.push(value);
    return {
      status: 200,
      body: JSON.stringify(
        value.type === "verification" ? { challenge: value.challenge } : {},
      ),
    };
  };
  const agent = { principal, list: () => tasks };
  const vault = new CredentialVault(join(d, "vault"), Buffer.alloc(32, 5));
  const e = new ExternalAgentEvents(
    join(d, "events.sqlite3"),
    agent,
    vault,
    webhook,
  );
  const p = {
    name: "envar.task.available",
    arguments: { agent_id: principal },
    delivery: {
      mode: "webhook",
      url: "https://receiver.example/mcp-events/abc",
      secret,
    },
  };
  try {
    await assert.rejects(e.subscribe(p, "wrong"), /scope|Agent/);
    await assert.rejects(
      e.subscribe(
        { ...p, delivery: { ...p.delivery, url: "http://127.0.0.1" } },
        principal,
      ),
      /HTTPS/,
    );
    const first = await e.subscribe(p, principal),
      second = await e.subscribe(p, principal);
    assert.equal(first.id, second.id);
    tasks = [{ taskId: randomUUID(), serviceId: "text-answer", claimId: "" }];
    await e.tick();
    await e.tick();
    assert.equal(
      calls.filter((x) => x.name === "envar.task.available").length,
      1,
    );
    assert.equal(e.inspect().deliveries[0].state, "delivered");
    e.unsubscribe(p, principal);
    tasks.push({ taskId: randomUUID(), serviceId: "text-answer", claimId: "" });
    await e.tick();
    assert.equal(calls.filter((x) => x.name).length, 1);
  } finally {
    await e.close();
    rmSync(d, { recursive: true, force: true });
  }
});
