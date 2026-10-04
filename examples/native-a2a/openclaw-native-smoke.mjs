/** Invoke the installed native OpenClaw A2A adapter with process-local fixture config.
 * No model call and no live gateway configuration change. Follow with standard GetTask.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const root = process.env.OPENCLAW_SOURCE_ROOT ?? "/opt/openclaw-runtime/app";
const { a2aChannelPlugin } = await import(
  pathToFileURL(root + "/dist/extensions/a2a/channel-plugin-api.js").href
);
const send = a2aChannelPlugin.outbound?.sendText;
if (typeof send !== "function")
  throw new Error("Installed native A2A sendText entry is unavailable");
const token = readFileSync(process.env.ENVAR_PROXY_TOKEN_FILE, "utf8").trim(),
  origin = process.env.ENVAR_PROXY_ORIGIN;
const cfg = {
  channels: {
    a2a: {
      enabled: true,
      peers: {
        approved_research: {
          token: "local-fixture-inbound-identity",
          url: origin + "/a2a",
          outboundToken: token,
        },
      },
    },
  },
};
const text = JSON.stringify({
  requestId: "native-openclaw-smoke",
  input: { request: "Native outbound fixture" },
});
const first = await send({ cfg, to: "a2a:approved_research", text }),
  second = await send({ cfg, to: "a2a:approved_research", text });
if (!first.messageId || first.messageId !== second.messageId)
  throw new Error(
    "Native regenerated message IDs did not deduplicate to the original Task",
  );
let result;
for (let i = 0; i < 40; i++) {
  const response = await fetch(origin + "/a2a", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
      "A2A-Version": "1.0",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "native-poll",
      method: "GetTask",
      params: { id: first.messageId },
    }),
    redirect: "error",
  });
  result = await response.json();
  if (result.result?.status?.state === "TASK_STATE_COMPLETED") break;
  await new Promise((resolve) => setTimeout(resolve, 100));
}
if (
  !JSON.stringify(result?.result?.artifacts).includes(
    "simulated native tool result",
  )
)
  throw new Error("Original A2A Task result was not readable");
console.log(
  JSON.stringify({
    runtime: "openclaw",
    entry: "a2aChannelPlugin.outbound.sendText",
    invocations: 2,
    sameTask: true,
    resultPolled: true,
    modelInvoked: false,
    realPayment: false,
  }),
);
