import {
  readFileSync,
  writeFileSync,
  lstatSync,
  existsSync,
  renameSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CommerceError } from "./types.js";

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
