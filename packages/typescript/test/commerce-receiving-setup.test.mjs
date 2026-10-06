import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const moduleUrl = new URL("../dist/commerce/configure.js", import.meta.url).href;
const payTo = "0x1111111111111111111111111111111111111111";
const payer = "0x2222222222222222222222222222222222222222";
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "envar-receiving-"));
  const save = (name, value) => writeFileSync(join(root, name), JSON.stringify(value), { mode: 0o600 });
  save("seller.json", { configVersion: 2, agent: { id: "hermes", name: "Hermes" }, services: [], paymentProfiles: {} });
  save("credentials.json", { callers: { "existing-access": "owner" }, payers: {} });
  save("envar.json", { policy: { agentId: "agent-1", allowedX402: [] } });
  save("connection.json", { url: "https://seller.example/.well-known/agent-card.json" });
  save("runtime.json", { port: 4020 });
  save("receiving.json", { version: 1, agentId: "agent-1", network: "eip155:84532", payTo, facilitatorUrl: "https://facilitator.example" });
  writeFileSync(join(root, "seller.sqlite3"), "original-ledger");
  writeFileSync(join(root, "envar.token"), "original-platform-token");
  return root;
}
async function run(root, approve) {
  const script = `Object.defineProperty(process.stdin,'isTTY',{value:true}); const {configurePayments}=await import(${JSON.stringify(moduleUrl)}); await configurePayments(process.argv[1],process.argv[2]);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script, root, join(root, "receiving.json")]);
  const steps = [["Approve this receiving account?", approve], ["x402 facilitator HTTPS URL", ""], ["Network RPC HTTPS URL", ""], ["Authorized buyer wallet address", payer]];
  let output = "", next = 0;
  child.stdout.on("data", data => {
    output += data;
    if (next < steps.length && output.includes(steps[next][0])) child.stdin.write(steps[next++][1] + "\n");
  });
  child.stderr.on("data", data => { output += data; });
  const timer = setTimeout(() => child.kill(), 10000);
  const code = await new Promise(resolve => child.on("close", resolve));
  clearTimeout(timer);
  assert.equal(code, 0, output);
}
test("guided receiving is Agent-bound, preserves ledger and creates only an authorized buyer credential", async () => {
  const root = fixture();
  try {
    await run(root, "yes");
    const auth = JSON.parse(readFileSync(join(root, "credentials.json")));
    assert.equal(auth.callers["existing-access"], "owner");
    assert.equal(auth.receivingProfiles[0].payTo, payTo);
    assert.equal(auth.receivingProfiles[0].network, "eip155:84532");
    const caller = "buyer-" + payer.slice(2);
    const tokenPath = join(root, caller + ".token");
    assert.equal(auth.callers[readFileSync(tokenPath, "utf8").trim()], caller);
    assert.equal(auth.payers[caller], payer);
    assert.equal(statSync(tokenPath).mode & 0o077, 0);
    assert.equal(readFileSync(join(root, "seller.sqlite3"), "utf8"), "original-ledger");
    assert.equal(readFileSync(join(root, "envar.token"), "utf8"), "original-platform-token");
    assert.equal(JSON.parse(readFileSync(join(root, "seller.json"))).services.length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("declining receiving confirmation leaves local configuration untouched", async () => {
  const root = fixture();
  try {
    const before = readFileSync(join(root, "credentials.json"), "utf8");
    await run(root, "no");
    assert.equal(readFileSync(join(root, "credentials.json"), "utf8"), before);
    assert.equal(existsSync(join(root, "vault.key")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
