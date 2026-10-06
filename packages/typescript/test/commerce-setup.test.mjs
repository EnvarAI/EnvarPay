import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSetupBundle, prepareTextSkill } from "../dist/commerce/setup.js";
import { loadCommerceConfig } from "../dist/commerce/config.js";
import {
  readInstalledSkills,
  createNativeSkillExecutor,
} from "../dist/commerce/native-skills.js";
import {
  CommerceServer,
  bearerAuthenticator,
} from "../dist/commerce/server.js";
import { CommerceStore } from "../dist/commerce/store.js";

const bundle = () => ({
  version: 1,
  agentId: "54fe760a-4580-4258-9002-80f34c0d757a",
  agentName: "Hermes",
  runtimeAgentId: "my-hermes",
  platformOrigin: "https://envar.ai",
  token: "envar_agent_" + "x".repeat(40),
  expiresAt: "2099-01-01T00:00:00Z",
});
test("setup rejects expired credentials and embedded platform paths before any local setup", () => {
  assert.equal(parseSetupBundle(bundle()).agentName, "Hermes");
  for (const changed of [
    { expiresAt: "2000-01-01" },
    { expiresAt: "never" },
    { platformOrigin: "https://envar.ai/evil" },
    { platformOrigin: "http://envar.ai" },
    { runtimeAgentId: "$(command)" },
    { token: "short" },
  ])
    assert.throws(() => parseSetupBundle({ ...bundle(), ...changed }));
});
test("reviewed service copies preserve original skill and inline-reference digest", () => {
  const root = mkdtempSync(join(tmpdir(), "skill-setup-"));
  try {
    const source = join(root, "original"),
      skills = join(root, "skills");
    mkdirSync(source);
    mkdirSync(skills);
    const original =
      "---\nname: copywriting\ndescription: Write supplied product copy\n---\nUse references/style.md.";
    writeFileSync(join(source, "SKILL.md"), original);
    mkdirSync(join(source, "references"));
    writeFileSync(join(source, "references/style.md"), "Use plain language.");
    prepareTextSkill(source, join(skills, "copywriting"), "copywriting");
    assert.equal(readFileSync(join(source, "SKILL.md"), "utf8"), original);
    const installed = readInstalledSkills(
      skills,
      [],
      "https://seller.example/.well-known/agent-card.json",
    );
    assert.match(installed[0].instructions, /Use plain language/);
    assert.equal(installed[0].descriptor.name, "copywriting");
    assert.equal(installed[0].descriptor.access, "paid");
    assert.throws(() =>
      prepareTextSkill(source, join(skills, "copywriting"), "copywriting"),
    );
    symlinkSync("/etc/passwd", join(source, "secret.md"));
    assert.throws(() =>
      prepareTextSkill(source, join(skills, "unsafe"), "unsafe"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("empty onboarding catalog exposes installed skills without permitting unpriced execution", async () => {
  const root = mkdtempSync(join(tmpdir(), "skill-bootstrap-"));
  let native, store;
  try {
    const skills = join(root, "skills");
    mkdirSync(skills);
    mkdirSync(join(skills, "copywriting"));
    writeFileSync(
      join(skills, "copywriting/SKILL.md"),
      "---\nname: copywriting\ndescription: Write product copy\nenvar-runtime: instruction-only\n---\nWrite clear copy.",
    );
    native = createNativeSkillExecutor(
      {
        framework: "hermes",
        skillsDirectory: skills,
        freeSkills: [],
        stateDirectory: join(root, "tasks"),
        python: "not-executed",
        model: "test",
        baseUrl: "https://model.example",
        apiKeyFile: "not-opened",
      },
      "https://seller.example",
      "Hermes",
    );
    store = new CommerceStore(join(root, "seller.db"));
    const config = loadCommerceConfig({
      configVersion: 2,
      agent: { id: "hermes", name: "Hermes" },
      services: [],
      paymentProfiles: {},
    });
    const server = new CommerceServer({
      config,
      origin: "https://seller.example",
      store,
      execute: native.execute,
      authenticate: bearerAuthenticator({ ["x".repeat(40)]: "owner" }),
      paymentGate: {
        handle: () => {
          throw Error("must not pay");
        },
      },
    });
    const card = await server.handle(
      new Request("https://seller.example/.well-known/agent-card.json"),
    );
    assert.equal(card.status, 200);
    assert.equal((await card.json()).skills[0].id, "copywriting");
    const raw = await server.handle(
      new Request("https://seller.example/a2a", { method: "POST", body: "{}" }),
    );
    assert.equal(raw.status, 400);
    assert.equal((await raw.json()).error, "service_required");
    server.stop();
  } finally {
    await native?.close();
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
