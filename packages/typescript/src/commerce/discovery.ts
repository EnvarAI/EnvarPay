import { readSkillInventory } from "./native-inventory.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  renameSync,
  rmSync,
  readdirSync,
  lstatSync,
} from "node:fs";
import {createHash} from 'node:crypto';
import { join } from "node:path";
import { createRequire } from "node:module";
import type { NativeSkillSettings } from "./native-skills.js";
import { prepareTextSkill } from "./setup.js";
import { readInstalledSkills } from "./native-skills.js";
import type { EnvarIntegration } from "./envar.js";

const exec = promisify(execFile);
function packageDigest(root:string):string{
  const files:[string,string][]=[];let size=0;
  function walk(folder:string,prefix=''){
    if(prefix.split('/').length>12)throw Error('skill_size');
    for(const name of readdirSync(folder).sort()){
      const path=join(folder,name),stat=lstatSync(path);
      if(stat.isSymbolicLink())throw Error('skill_symlink');
      if(stat.isDirectory()){walk(path,prefix+name+'/');continue;}
      if(!stat.isFile()||stat.size>512*1024||(size+=stat.size)>1024*1024||files.length>=128)throw Error('skill_size');
      files.push([prefix+name,createHash('sha256').update(readFileSync(path)).digest('hex')]);
    }
  }
  walk(root);files.sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0);
  const json=JSON.stringify(files).replace(/[\u007f-\uffff]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));
  return createHash('sha256').update(json).digest('hex');
}
interface FoundSkill {
  name: string;
  digest: string;
  path: string;
  description: string;
  supported: boolean;
}
export interface DiscoverySettings {
  hermesHome: string;
  enabledFromWeb: true;
  roots?: string[];
}
export class SkillDiscovery {
  private enabled: Record<string, string>;
  private cached: FoundSkill[] = [];
  private nextScan = 0;
  private state: "ready" | "agent_unavailable" | "scan_failed" = "ready";
  readonly path: string;
  constructor(
    private settings: NativeSkillSettings,
    private discovery: DiscoverySettings,
    private origin: string,
  ) {
    this.path = join(settings.skillsDirectory, ".source-digests.json");
    this.enabled = existsSync(this.path)
      ? JSON.parse(readFileSync(this.path, "utf8"))
      : {};
  }
  private async scan(): Promise<FoundSkill[]> {
    if (this.discovery.roots && !this.settings.dockerContainer) return readSkillInventory(this.discovery.roots);
    const code = readFileSync(
      new URL("../../examples/hermes-skill-inventory.py", import.meta.url),
      "utf8",
    );
    const args = ["-c", code, this.discovery.hermesHome];
    const { stdout } = this.settings.dockerContainer
      ? await exec(
          "docker",
          [
            "exec",
            this.settings.dockerContainer,
            this.settings.python,
            ...args,
          ],
          { timeout: 30000, maxBuffer: 1024 * 1024 },
        )
      : await exec(this.settings.python, args, {
          timeout: 30000,
          maxBuffer: 1024 * 1024,
        });
    const list = JSON.parse(stdout) as FoundSkill[];
    if (
      !Array.isArray(list) ||
      list.length > 128 ||
      list.some(
        (s) =>
          !/^[a-z][a-z0-9-]{0,63}$/.test(s.name) ||
          !/^[0-9a-f]{64}$/.test(s.digest) ||
          typeof s.path !== "string",
      )
    )
      throw Error("inventory");
    return list;
  }
  async sync(
    integration: EnvarIntegration,
    payments: { network: string; pay_to: string; facilitator_url: string }[],
  ): Promise<void> {
    if (Date.now() >= this.nextScan) {
      this.nextScan = Date.now() + 15000;
      try {
        this.cached = await this.scan();
        this.state = "ready";
      } catch {
        this.state = this.settings.dockerContainer
          ? "agent_unavailable"
          : "scan_failed";
      }
    }
    const active = new Set(
      readdirSync(this.settings.skillsDirectory, { withFileTypes: true })
        .filter((x) => x.isDirectory() && !x.name.startsWith("."))
        .map((x) => x.name),
    );
    for (const skill of this.cached)
      if (active.has(skill.name) && !this.enabled[skill.name])
        this.enabled[skill.name] = skill.digest;
    if (this.state === "ready")
      writeFileSync(this.path, JSON.stringify(this.enabled), { mode: 0o600 });
    const skills = this.cached.map((s) => ({
      name: s.name,
      digest: s.digest,
      description: s.description,
      status: !s.supported
        ? "requires_adapter"
        : active.has(s.name)
          ? this.enabled[s.name] && this.enabled[s.name] !== s.digest
            ? "updated"
            : "enabled"
          : "available",
    }));
    for (const name of active)
      if (!skills.some((s) => s.name === name))
        skills.push({
          name,
          digest: this.enabled[name] ?? "0".repeat(64),
          description: "",
          status: "removed",
        });
    const result = await integration.reportRuntime({
      version: createRequire(import.meta.url)("../../package.json").version,
      card_url: this.origin + "/.well-known/agent-card.json",
      state: this.state,
      skills: skills.slice(0, 128),
      payments: payments
        .filter(
          (p, i, all) =>
            all.findIndex((x) => JSON.stringify(x) === JSON.stringify(p)) === i,
        )
        .slice(0, 8),
    });
    for (const request of result) {
      const skill = this.cached.find(
        (s) =>
          s.name === request.name && s.digest === request.digest && s.supported,
      );
      if (!skill || active.has(skill.name) || this.state !== "ready") continue;
      // Check source again after the owner's request. Never overwrite a live package.
      const current = (await this.scan()).find(
        (s) =>
          s.name === skill.name && s.digest === skill.digest && s.supported,
      );
      if (!current) continue;
      const stage = mkdtempSync(
        join(this.settings.skillsDirectory, ".prepare-"),
      );
      try {
        let source = skill.path;
        if (this.settings.dockerContainer) {
          source = join(stage, "source");
          await exec(
            "docker",
            ["cp", `${this.settings.dockerContainer}:${skill.path}`, source],
            { timeout: 30000, maxBuffer: 1024 * 1024 },
          );
        }
        if(packageDigest(source)!==skill.digest)continue;
        const prepared = join(stage, "prepared");
        mkdirSync(prepared);
        prepareTextSkill(source, join(prepared, skill.name), skill.name);
        readInstalledSkills(
          prepared,
          [],
          this.origin + "/.well-known/agent-card.json",
        );
        const after = (await this.scan()).find((s) => s.name === skill.name);
        if (after?.digest !== skill.digest) continue;
        renameSync(
          join(prepared, skill.name),
          join(this.settings.skillsDirectory, skill.name),
        );
        this.enabled[skill.name] = skill.digest;
        writeFileSync(this.path, JSON.stringify(this.enabled), { mode: 0o600 });
        // This grant includes only the exact installed package explicitly selected in the owner UI.
        integration.allowInstalledService(skill.name);
      } finally {
        rmSync(stage, { recursive: true, force: true });
      }
    }
    for (const name of active) integration.allowInstalledService(name);
  }
}
