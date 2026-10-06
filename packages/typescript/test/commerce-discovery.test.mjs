import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillDiscovery } from "../dist/commerce/discovery.js";
import { readInstalledSkills } from "../dist/commerce/native-skills.js";
import { upgradeDiscovery } from "../dist/commerce/configure.js";
test("new Hermes install is discovered without restart, remains private, and only explicit matching approval enables a copy", async () => {
  const root = mkdtempSync(join(tmpdir(), "envar-discover-")),
    home = join(root, "hermes"),
    skills = join(root, "service-skills");
  mkdirSync(home);
  mkdirSync(join(home, "skills"));
  mkdirSync(skills);
  writeFileSync(join(home, "config.yaml"), "{}");
  const discovery = new SkillDiscovery(
    {
      framework: "hermes",
      skillsDirectory: skills,
      freeSkills: [],
      stateDirectory: join(root, "tasks"),
      python: process.env.ENVARPAY_TEST_PYTHON || "python3",
      model: "none",
      baseUrl: "https://model.example",
      apiKeyFile: "not-read",
    },
    { hermesHome: home, enabledFromWeb: true },
    "https://seller.example",
  );
  let value,
    enable = [];
  const granted = [];
  const integration = {
    reportRuntime: async (v) => {
      value = v;
      return enable;
    },
    allowInstalledService: (name) => granted.push(name),
  };
  try {
    await discovery.sync(integration, []);
    assert.equal(value.skills.length, 0);
    const source = join(home, "skills", "copywriting");
    mkdirSync(source);
    const original =
      "---\nname: copywriting\ndescription: Write product copy\n---\nWrite supplied text.";
    writeFileSync(join(source, "SKILL.md"), original);
    discovery.nextScan = 0;
    await discovery.sync(integration, []);
    assert.equal(value.skills[0].status, "available");
    assert.equal(existsSync(join(skills, "copywriting")), false);
    enable = [{ name: "copywriting", digest: "0".repeat(64) }];
    await discovery.sync(integration, []);
    assert.equal(existsSync(join(skills, "copywriting")), false);
    enable = [{ name: "copywriting", digest: value.skills[0].digest }];
    await discovery.sync(integration, []);
    assert.equal(existsSync(join(skills, "copywriting/SKILL.md")), true);
    assert.equal(readFileSync(join(source, "SKILL.md"), "utf8"), original);
    assert.ok(granted.includes("copywriting"));
    assert.equal(
      readInstalledSkills(
        skills,
        [],
        "https://seller.example/.well-known/agent-card.json",
      ).length,
      1,
    );
    writeFileSync(join(source, "SKILL.md"), original + "\nUpdated.");
    discovery.nextScan = 0;
    await discovery.sync(integration, []);
    assert.equal(value.skills[0].status, "updated");
    assert.ok(
      !readFileSync(join(skills, "copywriting/SKILL.md"), "utf8").includes(
        "Updated.",
      ),
    );
    rmSync(source, { recursive: true });
    discovery.nextScan = 0;
    await discovery.sync(integration, []);
    assert.equal(value.skills[0].status, "removed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("upgrade preserves the original ledger, token and port and enables discovery only for the selected profile", () => {
  const root = mkdtempSync(join(tmpdir(), "envar-upgrade-"));
  try {
    const save = (p, v) =>
      writeFileSync(join(root, p), JSON.stringify(v), { mode: 0o600 });
    save("credentials.json", {
      callers: { "private-token": "owner" },
      skills: {
        framework: "hermes",
        dockerStateDirectory: "/runtime-home/envarpay-tasks/agent",
      },
    });
    save("connection.json", {
      url: "https://seller.example/.well-known/agent-card.json",
    });
    writeFileSync(join(root, "seller.sqlite3"), "original-ledger");
    writeFileSync(join(root, "envar.token"), "original-platform-token");
    writeFileSync(
      join(root, "start.mjs"),
      'const child=spawn("/node",["old-cli","serve","--port","4020"],{stdio:\'inherit\'});',
    );
    upgradeDiscovery(root);
    assert.equal(
      readFileSync(join(root, "seller.sqlite3"), "utf8"),
      "original-ledger",
    );
    assert.equal(
      readFileSync(join(root, "envar.token"), "utf8"),
      "original-platform-token",
    );
    const c = JSON.parse(readFileSync(join(root, "credentials.json")));
    assert.equal(c.skills.discovery.hermesHome, "/runtime-home");
    assert.equal(c.callers["private-token"], "owner");
    assert.equal(
      JSON.parse(readFileSync(join(root, "runtime.json"))).port,
      4020,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
