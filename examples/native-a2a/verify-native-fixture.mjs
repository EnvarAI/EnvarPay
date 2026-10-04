/** ZERO-PAYMENT fixture for native transport verification. Never a production buyer. */
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  A2APeerProxy,
  listenPeerProxy,
} from "../../packages/typescript/dist/commerce/peer-proxy.js";
const [origin, stateDirectory, tokenFile, evidenceFile] = process.argv.slice(2);
if (!evidenceFile)
  throw new Error(
    "origin stateDirectory proxy-token-file evidence-file required",
  );
const token = readFileSync(tokenFile, "utf8").trim(),
  rows = new Map(),
  counts = {
    previews: 0,
    simulatedConfirmations: 0,
    modelInvocations: 0,
    realPayments: 0,
  };
function evidence() {
  writeFileSync(
    evidenceFile,
    JSON.stringify({
      kind: "native_outbound_transport_fixture",
      ...counts,
      purchases: rows.size,
    }),
    { mode: 0o600 },
  );
}
const buyer = {
  policy: {
    approval: "within_preapproved_limits",
    paymentsEnabled: true,
    peers: [
      {
        id: "fixture",
        cardUrl: "https://fixture.invalid/card",
        protocol: "x402",
        currency: "test-usdc",
        recipient: "fixture",
        maxPerPurchase: "100",
      },
    ],
    budgets: [{ currency: "test-usdc", maxTotal: "200", period: "cumulative" }],
  },
  policySnapshot() {
    return structuredClone(this.policy);
  },
  async preview(caller, input) {
    counts.previews++;
    let row = [...rows.values()].find((r) => r.messageId === input.messageId);
    if (!row) {
      row = {
        id: randomUUID(),
        quoteToken: "fixture-owner-token-never-real",
        messageId: input.messageId,
        state: "previewed",
        paymentState: "quoted",
        executionState: "not_started",
        quote: { amount: "100", currency: "test-usdc", recipient: "fixture" },
      };
      rows.set(row.id, row);
    }
    evidence();
    return structuredClone(row);
  },
  async confirm(_caller, input) {
    const row = rows.get(input.previewId);
    if (row.state === "previewed") {
      counts.simulatedConfirmations++;
      row.state = "completed";
      row.paymentState = "confirmed";
      row.executionState = "completed";
      row.task = {
        id: "fixture-remote-" + row.id,
        status: { state: "TASK_STATE_COMPLETED" },
        artifacts: [
          {
            artifactId: "result",
            parts: [{ text: "simulated native tool result" }],
          },
        ],
      };
    }
    evidence();
    return structuredClone(row);
  },
  get(_caller, id) {
    return structuredClone(rows.get(id));
  },
  async continue() {
    throw new Error("Fixture does not support continuation");
  },
};
const proxy = new A2APeerProxy({
  buyer,
  buyerCaller: "fixture-owner",
  peerId: "fixture",
  offerId: "fixture",
  origin,
  stateDirectory,
  tokens: { [token]: "native-fixture" },
  waitMilliseconds: 2000,
  allowPrivateHttp: true,
});
const server = listenPeerProxy(proxy, "0.0.0.0", Number(new URL(origin).port));
server.once("listening", () => {
  evidence();
  console.log(
    JSON.stringify({ ready: true, realPayments: 0, modelInvocations: 0 }),
  );
});
async function stop() {
  await proxy.stop();
  await new Promise((resolve) => server.close(resolve));
  proxy.close();
  evidence();
}
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());
