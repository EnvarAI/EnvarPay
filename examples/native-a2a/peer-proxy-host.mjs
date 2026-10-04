/** Private wallet-owner example; never run inside an Agent container with wallet keys mounted.
 * The local owner-only module exports createProxyOptions(), reusing one CommerceBuyer instance.
 */
import { lstatSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import {
  A2APeerProxy,
  listenPeerProxy,
} from "../../packages/typescript/dist/commerce/peer-proxy.js";
const path = resolve(process.argv[2] ?? "");
const stat = lstatSync(path);
if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
  throw new Error("Use an owner-only local options module");
const { createProxyOptions } = await import(pathToFileURL(path).href);
const options = await createProxyOptions(),
  proxy = new A2APeerProxy(options);
options.buyer.start();
const server = listenPeerProxy(
  proxy,
  process.env.ENVAR_PROXY_HOST ?? "127.0.0.1",
  Number(new URL(proxy.origin).port || 4030),
);
async function stop() {
  await proxy.stop();
  await new Promise((resolve) => server.close(resolve));
  await options.buyer.stop();
  proxy.close();
}
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());
