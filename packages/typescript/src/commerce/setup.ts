/** Guided local installation. Platform input is data, never a shell command or wallet policy. */
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  cpSync,
  mkdtempSync,
  renameSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { readInstalledSkills } from "./native-skills.js";
import { loadCommerceConfig, validateUrl } from "./config.js";
import { CommerceError } from "./types.js";

const ID = /^[a-z][a-z0-9-]{0,63}$/,
  CONTAINER = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
export interface SetupBundle {
  version: 1;
  agentId: string;
  agentName: string;
  runtimeAgentId: string;
  platformOrigin: string;
  token: string;
  expiresAt: string;
}
export function parseSetupBundle(raw: unknown): SetupBundle {
  const v = raw as SetupBundle;
  if (
    !v ||
    v.version !== 1 ||
    !/^[0-9a-f-]{36}$/.test(v.agentId) ||
    !ID.test(v.runtimeAgentId) ||
    typeof v.agentName !== "string" ||
    v.agentName.length > 120 ||
    !/^envar_agent_[A-Za-z0-9_-]{32,100}$/.test(v.token) ||
    !Number.isFinite(Date.parse(v.expiresAt)) ||
    Date.parse(v.expiresAt) <= Date.now()
  )
    throw new CommerceError(
      "setup_file",
      "Download a fresh Agent setup file from Envar",
    );
  const origin = validateUrl(v.platformOrigin);
  if (origin.origin !== v.platformOrigin)
    throw new CommerceError("setup_origin", "Use the platform HTTPS origin");
  return v;
}
export function prepareTextSkill(
  source: string,
  destination: string,
  name: string,
): void {
  if (!ID.test(name) || existsSync(destination))
    throw new CommerceError("setup_skill", "Choose a new exact skill name");
  const stat = lstatSync(source);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new CommerceError("setup_skill", "Choose a real skill directory");
  cpSync(source, destination, {
    recursive: true,
    filter: (path) => {
      const item = lstatSync(path);
      if (item.isSymbolicLink())
        throw new CommerceError(
          "setup_skill",
          "Skill symlinks are unsupported",
        );
      if (
        item.isFile() &&
        !/\.(md|txt)$/i.test(path) &&
        !path.endsWith("/LICENSE")
      )
        throw new CommerceError(
          "setup_skill",
          "Choose a text-only package without scripts or binaries",
        );
      return true;
    },
  });
  const file = join(destination, "SKILL.md"),
    original = readFileSync(file, "utf8");
  if (!original.startsWith("---\n") && !original.startsWith("---\r\n"))
    throw new CommerceError("setup_skill", "Skill needs YAML frontmatter");
  const adapted = original.replace(
    /^(---\r?\n)([\s\S]*?)(\r?\n---)/,
    (_all, open, front, close) =>
      open +
      front.replace(/^envar-runtime:.*\r?\n?/gm, "") +
      "\nenvar-runtime: instruction-only" +
      close,
  );
  writeFileSync(
    file,
    adapted +
      "\n\n## Service execution\nUse the supplied buyer input as the complete product context. Bundled Markdown references are included in the task context. Return text in the A2A result. Do not browse, access files, run scripts, or invoke other skills. If information is missing, state what is missing; do not invent it.\n",
    { mode: 0o600 },
  );
}
function privateJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
}
interface Probe {
  home: string;
  python: string;
  model: string;
  baseUrl: string;
  apiKeyFile: string | null;
  apiKey: string | null;
  skills: {
    name: string;
    path: string;
    description: string;
    textPackage: boolean;
    files: number;
  }[];
}
export async function setupHermes(options: {
  file: string;
  directory?: string;
  container?: string;
  python?: string;
  home?: string;
}): Promise<void> {
  const file = resolve(options.file),
    info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 16384)
    throw new CommerceError("setup_file", "Use the downloaded setup JSON file");
  const bundle = parseSetupBundle(JSON.parse(readFileSync(file, "utf8")));
  if (options.container && !CONTAINER.test(options.container))
    throw new CommerceError("setup_container", "Use a Docker container name");
  if (!process.stdin.isTTY)
    throw new CommerceError(
      "setup_terminal",
      "Run setup in an interactive terminal to select skills",
    );
  chmodSync(file, 0o600);
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const ask = async (label: string, fallback = "") =>
    (
      await prompt.question(`${label}${fallback ? ` [${fallback}]` : ""}: `)
    ).trim() || fallback;
  let staging: string | undefined;
  try {
    console.log(
      `\nConnect ${bundle.agentName} to ${bundle.platformOrigin}\nModel credentials and tasks remain on this machine. Start with free services; no wallet is created.\n`,
    );
    if ((await ask("Continue? (yes/no)", "no")).toLowerCase() !== "yes") return;
    const directory = resolve(
      options.directory ?? join(homedir(), ".envarpay", bundle.agentId),
    );
    if (existsSync(directory))
      throw new CommerceError(
        "setup_exists",
        "This Agent already has a local directory. Use its start script; never reset its ledger.",
      );
    let python = options.python;
    const compatibility =
      'import inspect;from run_agent import AIAgent;assert all(k in inspect.signature(AIAgent).parameters for k in ["skip_context_files","skip_memory","skip_background_review","ephemeral_system_prompt","enabled_toolsets"])';
    if (!python && options.container) {
      for (const candidate of [
        "/opt/hermes-latest/bin/python",
        "/opt/hermes/.venv/bin/python",
        "python3",
      ]) {
        try {
          execFileSync(
            "docker",
            ["exec", options.container, candidate, "-c", compatibility],
            { stdio: "pipe", timeout: 60000 },
          );
          python = candidate;
          break;
        } catch {
          /* try the next compatible installed interpreter */
        }
      }
      if (!python)
        throw new CommerceError(
          "setup_runtime",
          "No compatible Hermes interpreter found in this container. Update Hermes or pass --python PATH.",
        );
    }
    python ??= await ask(
      "Hermes Python executable",
      join(homedir(), "hermes-agent", ".venv", "bin", "python"),
    );
    const probeSource = readFileSync(
      new URL("../../examples/hermes-setup-probe.py", import.meta.url),
      "utf8",
    );
    let probe: Probe;
    try {
      if (options.container)
        execFileSync(
          "docker",
          ["exec", options.container, python, "-c", compatibility],
          { stdio: "pipe", timeout: 60000 },
        );
      else
        execFileSync(python, ["-c", compatibility], {
          stdio: "pipe",
          timeout: 60000,
        });
      const args = ["-c", probeSource, ...(options.home ? [options.home] : [])];
      const data = options.container
        ? execFileSync("docker", ["exec", options.container, python, ...args], {
            stdio: "pipe",
            timeout: 30000,
            maxBuffer: 2 * 1024 * 1024,
          })
        : execFileSync(python, args, {
            stdio: "pipe",
            timeout: 30000,
            maxBuffer: 2 * 1024 * 1024,
          });
      probe = JSON.parse(data.toString());
    } catch {
      throw new CommerceError(
        "setup_model",
        "Could not read Hermes. Check the container/Python path and configure an OpenAI-compatible model in Hermes first.",
      );
    }
    const candidates = probe.skills.filter(
      (s) => s.textPackage && ID.test(s.name),
    );
    console.log(
      `Model: ${probe.model}\nInstalled text packages (review their instructions before selecting):`,
    );
    candidates.forEach((skill, i) =>
      console.log(
        `${i + 1}. ${skill.name} — ${skill.description.replace(/[\r\n\x1b]/g, " ").slice(0, 160)}`,
      ),
    );
    if (!candidates.length)
      throw new CommerceError(
        "setup_skills",
        "Install a text skill in Hermes first, then run setup again",
      );
    const selected = (await ask("Skill names to offer (comma separated)"))
      .split(",")
      .map((s) => s.trim());
    if (
      !selected.length ||
      selected.length > 32 ||
      new Set(selected).size !== selected.length ||
      selected.some((name) => !candidates.some((s) => s.name === name))
    )
      throw new CommerceError(
        "setup_skills",
        "Choose installed skill names from the list",
      );
    console.log(
      "This adapter supplies buyer text and bundled Markdown references. Browser, script, file and API tools are disabled. Original Hermes skills are preserved; a service copy is created.",
    );
    if (
      (
        await ask(
          "Do these selected skills work with text input and text output only? (yes/no)",
          "no",
        )
      ).toLowerCase() !== "yes"
    )
      return;
    const port = Number(await ask("Local service port", "4020"));
    if (!Number.isInteger(port) || port < 1024 || port > 65535)
      throw new CommerceError(
        "setup_port",
        "Choose a local port from 1024 to 65535",
      );
    let origin: string;
    const tunnelMode = await ask(
      "Public HTTPS: use an existing ngrok session or your own reverse proxy? (ngrok/url)",
      "ngrok",
    );
    if (tunnelMode === "ngrok") {
      const api = new URL(
        await ask("Local ngrok API", "http://127.0.0.1:4040"),
      );
      if (
        api.protocol !== "http:" ||
        api.hostname !== "127.0.0.1" ||
        api.username ||
        api.password ||
        api.pathname !== "/"
      )
        throw new CommerceError(
          "setup_tunnel",
          "Use the local ngrok API on 127.0.0.1",
        );
      const name = `envarpay-${bundle.agentId}`,
        addr = `http://127.0.0.1:${port}`;
      const inventory = await fetch(new URL("/api/tunnels", api), {
        signal: AbortSignal.timeout(10000),
      });
      if (!inventory.ok)
        throw new CommerceError(
          "setup_tunnel",
          "Start ngrok first, or choose your own HTTPS URL",
        );
      const existing = (
        (await inventory.json()) as {
          tunnels: {
            name: string;
            public_url: string;
            config: { addr: string };
          }[];
        }
      ).tunnels.find((t) => t.name === name);
      if (existing) {
        if (existing.config.addr !== addr)
          throw new CommerceError(
            "setup_tunnel",
            "The existing Agent tunnel uses another local port. Keep its original port.",
          );
        origin = existing.public_url;
      } else {
        const response = await fetch(new URL("/api/tunnels", api), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name,
            proto: "http",
            addr,
            schemes: ["https"],
            inspect: false,
          }),
          signal: AbortSignal.timeout(15000),
        });
        if (!response.ok)
          throw new CommerceError(
            "setup_tunnel",
            "Could not create a dedicated tunnel. Check ngrok or choose your own HTTPS URL. Existing tunnels were preserved.",
          );
        origin = ((await response.json()) as { public_url: string }).public_url;
      }
    } else if (tunnelMode === "url") {
      origin = await ask(
        `Public HTTPS origin (forward to http://127.0.0.1:${port})`,
      );
    } else throw new CommerceError("setup_tunnel", "Choose ngrok or url");
    const publicUrl = validateUrl(origin);
    if (
      publicUrl.origin !== origin ||
      (publicUrl.port && publicUrl.port !== "443")
    )
      throw new CommerceError("setup_origin", "Use an HTTPS origin on port443");
    // Only publish a complete new setup directory. An interrupted setup cannot strand
    // the owner behind setup_exists or overwrite a prior ledger.
    mkdirSync(resolve(directory, ".."), { recursive: true, mode: 0o700 });
    staging = mkdtempSync(directory + ".setup-");
    chmodSync(staging, 0o700);
    const skillsDirectory = join(staging, "skills");
    mkdirSync(skillsDirectory, { mode: 0o700 });
    for (const name of selected) {
      const skill = candidates.find((s) => s.name === name)!;
      if (options.container) {
        const incoming = join(staging, `incoming-${name}`);
        execFileSync(
          "docker",
          ["cp", `${options.container}:${skill.path}`, incoming],
          { stdio: "pipe", timeout: 30000 },
        );
        prepareTextSkill(incoming, join(skillsDirectory, name), name);
        rmSync(incoming, { recursive: true });
      } else prepareTextSkill(skill.path, join(skillsDirectory, name), name);
    }
    readInstalledSkills(
      skillsDirectory,
      [],
      origin + "/.well-known/agent-card.json",
    );
    const access = randomBytes(36).toString("base64url");
    let apiKeyFile = probe.apiKeyFile;
    if (!apiKeyFile) {
      if (options.container) {
        apiKeyFile = join(
          probe.home,
          "envarpay-secrets",
          bundle.agentId,
          "model.key",
        );
        // Key bytes travel through stdin, never process arguments or console output.
        const writeKey =
          "import sys,os;from pathlib import Path;p=Path(sys.argv[1]);p.parent.mkdir(parents=True,exist_ok=True,mode=0o700);fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600);os.write(fd,sys.stdin.buffer.read());os.close(fd)";
        try {
          execFileSync(
            "docker",
            [
              "exec",
              "-i",
              options.container,
              python,
              "-c",
              writeKey,
              apiKeyFile,
            ],
            {
              input: probe.apiKey!,
              stdio: ["pipe", "pipe", "pipe"],
              timeout: 15000,
            },
          );
        } catch {
          throw new CommerceError(
            "setup_model",
            "Could not save the local model credential. Inspect the Agent-specific envarpay-secrets directory before retrying.",
          );
        }
      } else {
        apiKeyFile = join(directory, "model.key");
        writeFileSync(join(staging, "model.key"), probe.apiKey!, {
          mode: 0o600,
          flag: "wx",
        });
      }
    }
    const stateDirectory = join(directory, "tasks");
    mkdirSync(join(staging, "tasks"), { mode: 0o700 });
    const dockerStateDirectory = options.container
      ? join(probe.home, "envarpay-tasks", bundle.agentId)
      : undefined;
    const config = loadCommerceConfig({
      configVersion: 2,
      agent: { id: bundle.runtimeAgentId, name: bundle.agentName },
      paymentProfiles: {},
      services: [],
    });
    privateJson(join(staging, "seller.json"), config);
    privateJson(join(staging, "credentials.json"), {
      callers: { [access]: "owner" },
      upstreams: {},
      skills: {
        framework: "hermes",
        skillsDirectory: join(directory, "skills"),
        freeSkills: [],
        stateDirectory,
        python,
        model: probe.model,
        baseUrl: probe.baseUrl,
        apiKeyFile,
        ...(options.container
          ? { dockerContainer: options.container, dockerStateDirectory }
          : {}),
      },
    });
    writeFileSync(join(staging, "envar.token"), bundle.token, {
      mode: 0o600,
      flag: "wx",
    });
    privateJson(join(staging, "envar.json"), {
      policy: {
        enabled: true,
        platformOrigin: bundle.platformOrigin,
        agentId: bundle.agentId,
        runtimeAgentId: bundle.runtimeAgentId,
        acceptUpdates: true,
        allowedServices: selected,
        allowedUpstreamOrigins: [origin],
        allowedX402: [],
        allowedMppAccounts: [],
      },
      stateDirectory: join(directory, "envar-state"),
      configDirectory: join(directory, "envar-configs"),
    });
    privateJson(join(staging, "connection.json"), {
      version: 1,
      agentId: bundle.agentId,
      url: origin + "/.well-known/agent-card.json",
      authToken: access,
    });
    const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
    const args = [
      cli,
      "serve",
      "--config",
      join(directory, "seller.json"),
      "--credentials",
      join(directory, "credentials.json"),
      "--state",
      join(directory, "seller.sqlite3"),
      "--origin",
      origin,
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--envar-config",
      join(directory, "envar.json"),
      "--envar-credentials",
      join(directory, "envar.token"),
    ];
    const start = join(directory, "start.mjs");
    writeFileSync(
      join(staging, "start.mjs"),
      `import {spawn} from 'node:child_process';\nconst child=spawn(${JSON.stringify(process.execPath)},${JSON.stringify(args)},{stdio:'inherit'});\nfor(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>child.kill(signal));\nchild.on('exit',code=>process.exit(code??1));\n`,
      { mode: 0o700, flag: "wx" },
    );
    writeFileSync(
      join(staging, "README.md"),
      `# ${bundle.agentName}\n\nStart: node ${JSON.stringify(start)}\n\nKeep the terminal, Hermes, and HTTPS tunnel running. Import connection.json in the Envar setup page, then check the connection. Choose a skill and save a free service. Request publication; this process applies the selected service automatically. Return to Envar and check/publish.\n\nOnly free service updates are authorized. Receiving and payment setup is separate. Platform token expires ${bundle.expiresAt}. Keep the original files and ledger when restarting.\n`,
      { mode: 0o600, flag: "wx" },
    );
    renameSync(staging, directory);
    staging = undefined;
    console.log(
      `\nReady. Start the local service:\n${process.execPath} ${JSON.stringify(start)}\n\nThen import this connection file in Envar:\n${join(directory, "connection.json")}\n\nKeep the service and HTTPS tunnel online. No task or payment was performed.`,
    );
  } finally {
    prompt.close();
    if (staging) rmSync(staging, { recursive: true, force: true });
  }
}
