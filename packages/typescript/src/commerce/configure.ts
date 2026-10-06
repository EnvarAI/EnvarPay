import {
  readFileSync,
  writeFileSync,
  lstatSync,
  existsSync,
  renameSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { CommerceError } from "./types.js";
import { validateUrl, loadCommerceConfig } from "./config.js";

function read(path: string): any {
  const s = lstatSync(path);
  if (
    !s.isFile() ||
    s.isSymbolicLink() ||
    s.size > 1024 * 1024 ||
    s.mode & 0o077
  )
    throw new CommerceError(
      "private_file",
      "Use an owner-only configuration file",
    );
  return JSON.parse(readFileSync(path, "utf8"));
}
function save(path: string, value: unknown): void {
  const temp = path + ".tmp";
  writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  renameSync(temp, path);
}
export function refreshLauncher(directory: string): void {
  const root = resolve(directory),
    connection = read(join(root, "connection.json")),
    settingsPath = join(root, "runtime.json");
  // alpha.10 start scripts recorded the port in generated source. Parse JSON argv only; never evaluate code.
  let port: number;
  if (existsSync(settingsPath)) port = read(settingsPath).port;
  else {
    const old = readFileSync(join(root, "start.mjs"), "utf8");
    const array = /spawn\([^\n]*?,(\[[^\n]+\]),\{stdio:/.exec(old)?.[1];
    if (!array)
      throw new CommerceError(
        "setup_upgrade",
        "Cannot infer original start settings. Use serve with original files.",
      );
    const args = JSON.parse(array) as string[];
    port = Number(args[args.indexOf("--port") + 1]);
  }
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new CommerceError("setup_port", "Invalid local service port");
  const args = [
    fileURLToPath(new URL("./cli.js", import.meta.url)),
    "serve",
    "--config",
    join(root, "seller.json"),
    "--credentials",
    join(root, "credentials.json"),
    "--state",
    join(root, "seller.sqlite3"),
    "--origin",
    new URL(connection.url).origin,
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--envar-config",
    join(root, "envar.json"),
    "--envar-credentials",
    join(root, "envar.token"),
  ];
  save(settingsPath, { port });
  const start = join(root, "start.mjs");
  writeFileSync(
    start,
    `import {spawn} from 'node:child_process';\nconst child=spawn(${JSON.stringify(process.execPath)},${JSON.stringify(args)},{stdio:'inherit'});\nfor(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>child.kill(signal));\nchild.on('exit',code=>process.exit(code??1));\n`,
    { mode: 0o700 },
  );
}
export function upgradeDiscovery(directory: string, home?: string): void {
  const root = resolve(directory),
    file = join(root, "credentials.json"),
    credentials = read(file);
  if (credentials.skills?.framework !== "hermes")
    throw new CommerceError(
      "setup_framework",
      "This discovery setup supports Hermes",
    );
  const skill = credentials.skills;
  const hermesHome =
    home ??
    skill.discovery?.hermesHome ??
    (skill.dockerStateDirectory
      ? dirname(dirname(skill.dockerStateDirectory))
      : undefined);
  if (!hermesHome)
    throw new CommerceError(
      "setup_home",
      "Pass --hermes-home with your existing Hermes profile directory",
    );
  credentials.skills.discovery = { hermesHome, enabledFromWeb: true };
  refreshLauncher(root);
  save(file, credentials);
  console.log(
    `Discovery enabled. Stop the original service with Ctrl+C, then restart:\n${process.execPath} ${JSON.stringify(join(root, "start.mjs"))}\nInstalled Skills will appear privately in Envar. No service is automatically enabled or published.`,
  );
}
export async function configurePayments(
  directory: string,
  file: string,
): Promise<void> {
  if (!process.stdin.isTTY)
    throw new CommerceError(
      "setup_terminal",
      "Use an interactive terminal to approve receiving configuration",
    );
  const root = resolve(directory),
    bundle = JSON.parse(readFileSync(file, "utf8"));
  const cfg = read(join(root, "seller.json")),
    auth = read(join(root, "credentials.json")),
    sync = read(join(root, "envar.json"));
  const assets: Record<string, string> = {
    "eip155:8453": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    "eip155:84532": "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
  };
  if (
    bundle.version !== 1 ||
    bundle.agentId !== sync.policy.agentId ||
    !assets[bundle.network] ||
    !/^0x[0-9a-fA-F]{40}$/.test(bundle.payTo) ||
    BigInt(bundle.payTo) === 0n
  )
    throw new CommerceError(
      "payment_setup",
      "Download receiving settings for this Agent",
    );
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const ask = async (text: string, fallback = "") =>
    (
      await prompt.question(`${text}${fallback ? ` [${fallback}]` : ""}: `)
    ).trim() || fallback;
  try {
    console.log(
      `Receiving account: ${bundle.payTo}\nNetwork: ${bundle.network === "eip155:8453" ? "Base mainnet" : "Base Sepolia testnet"}\nAsset: official USDC. This enables receiving only; it does not send money or create a signing key.`,
    );
    if ((await ask("Approve this receiving account? (yes/no)", "no")) !== "yes")
      return;
    const facilitator = validateUrl(
      await ask("x402 facilitator HTTPS URL", bundle.facilitatorUrl ?? ""),
    );
    const rpc = validateUrl(
      await ask(
        "Network RPC HTTPS URL",
        bundle.network === "eip155:8453"
          ? "https://mainnet.base.org"
          : "https://sepolia.base.org",
      ),
    );
    const payer = await ask("Authorized buyer wallet address");
    if (!/^0x[0-9a-fA-F]{40}$/.test(payer) || BigInt(payer) === 0n)
      throw new CommerceError(
        "payment_setup",
        "Use the buyer wallet address for this service access credential",
      );
    const caller = "buyer-" + payer.slice(2).toLowerCase(),
      token = randomBytes(36).toString("base64url");
    auth.callers = { ...auth.callers, [token]: caller };
    auth.payers = { ...auth.payers, [caller]: payer };
    auth.rpcUrls = { ...auth.rpcUrls, [bundle.network]: rpc.href };
    auth.vaultKeyFile ??= join(root, "vault.key");
    if (!existsSync(auth.vaultKeyFile))
      writeFileSync(auth.vaultKeyFile, randomBytes(32), {
        mode: 0o600,
        flag: "wx",
      });
    const profile = {
      adapter: "x402",
      scheme: "exact",
      network: bundle.network,
      asset: assets[bundle.network],
      payTo: bundle.payTo,
      facilitatorUrl: facilitator.href,
    };
    loadCommerceConfig({
      ...cfg,
      paymentProfiles: { ...cfg.paymentProfiles, "setup-receiving": profile },
    });
    auth.receivingProfiles = [
      ...(auth.receivingProfiles ?? []).filter(
        (p: any) => p.network !== bundle.network,
      ),
      profile,
    ];
    sync.policy.allowedX402 = [
      ...sync.policy.allowedX402.filter(
        (p: any) => p.network !== bundle.network,
      ),
      {
        network: bundle.network,
        asset: assets[bundle.network],
        payTo: bundle.payTo.toLowerCase(),
        facilitatorOrigin: facilitator.origin,
      },
    ];
    const accessFile = join(root, caller + ".token");
    writeFileSync(accessFile, token + "\n", { mode: 0o600 });
    save(join(root, "credentials.json"), auth);
    save(join(root, "envar.json"), sync);
    refreshLauncher(root);
    console.log(
      `Receiving configured for ${cfg.agent.name}. Restart the local service using start.mjs, then refresh Envar.\nBuyer service-access token: ${accessFile}\nGive this file only to the authorized buyer. Original wallets, budgets and ledgers were preserved. No payment performed.`,
    );
  } finally {
    prompt.close();
  }
}
