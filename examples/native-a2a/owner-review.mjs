/** OWNER-ONLY review/approval helper. Never mount its credential file in an Agent container. */
import { readFileSync, lstatSync } from "node:fs";
import { parseArgs } from "node:util";
import { digest } from "../../packages/typescript/dist/commerce/config.js";
const { values } = parseArgs({
  options: {
    origin: { type: "string" },
    "token-file": { type: "string" },
    "purchase-id": { type: "string" },
    "input-file": { type: "string" },
    approve: { type: "boolean" },
    "accept-digest": { type: "string" },
  },
});
for (const key of ["origin", "token-file", "purchase-id", "input-file"])
  if (!values[key])
    throw new Error(
      "origin, token-file, purchase-id and input-file are required",
    );
const origin = new URL(values.origin);
if (
  origin.pathname !== "/" ||
  origin.search ||
  origin.hash ||
  origin.username ||
  !["https:", "http:"].includes(origin.protocol)
)
  throw new Error("Use one exact private management origin");
if (!/^[0-9a-f-]{36}$/i.test(values["purchase-id"]))
  throw new Error("Use the original purchase UUID");
if (
  origin.protocol === "http:" &&
  !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)
)
  throw new Error("Private management requires HTTPS outside loopback");
const stat = lstatSync(values["token-file"]);
if (
  !stat.isFile() ||
  stat.isSymbolicLink() ||
  (stat.mode & 0o077) !== 0 ||
  stat.size > 4096
)
  throw new Error("Use an owner-only private management token file");
const token = readFileSync(values["token-file"], "utf8").trim();
async function request(path, body) {
  const response = await fetch(new URL(path, origin), {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: "error",
    signal: AbortSignal.timeout(30000),
  });
  const text = await response.text();
  if (text.length > 1048576)
    throw new Error("Management response exceeds limit");
  if (!response.ok)
    throw new Error(
      "Original private management operation failed: HTTP " + response.status,
    );
  return JSON.parse(text);
}
const purchase = await request(
  "/management/v1/purchases/" + values["purchase-id"],
);
const input = JSON.parse(readFileSync(values["input-file"], "utf8"));
if (
  purchase.id !== values["purchase-id"] ||
  digest(input) !== purchase.quote.inputDigest
)
  throw new Error("Input does not match this original purchase");
const review = {
  id: purchase.id,
  messageId: purchase.messageId,
  input,
  quote: purchase.quote,
};
const reviewDigest = digest(review);
if (!values.approve) {
  console.log(
    JSON.stringify(
      {
        ...review,
        reviewDigest,
        paymentState: purchase.paymentState,
        executionState: purchase.executionState,
      },
      null,
      2,
    ),
  );
} else {
  if (values["accept-digest"] !== reviewDigest)
    throw new Error(
      "Review the exact input, recipient, amount and expiry first; pass that reviewDigest explicitly",
    );
  const result = await request("/management/v1/purchases/confirm", {
    previewId: purchase.id,
    quoteToken: purchase.quoteToken,
    messageId: purchase.messageId,
  });
  console.log(
    JSON.stringify({
      id: result.id,
      paymentState: result.paymentState,
      executionState: result.executionState,
      errorCode: result.errorCode,
    }),
  );
}
