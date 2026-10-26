/** Targeted local configuration for each supported native platform. Never exports model credentials. */
import { existsSync, lstatSync, readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import JSON5 from 'json5';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { digest, validateUrl } from '../commerce/config.js';
import { privateJson, privateText, writePrivate, writePrivateJson } from '../connector/files.js';
import type { ConnectorConfig } from '../connector/config.js';

type RecordValue = Record<string, any>;
const connectorVersion = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version as string;
function object(value: unknown): RecordValue {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Native configuration has an unexpected shape');
  return value as RecordValue;
}
function readProfile(path: string): string {
  if (!existsSync(path)) return '';
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('Use a bounded regular native configuration file');
  return readFileSync(path, 'utf8');
}
function readConfig(path: string, yaml: boolean): RecordValue {
  try { const text = readProfile(path); return object(text.trim() ? (yaml ? parseYaml(text) : JSON5.parse(text)) : {}); }
  catch { throw new Error('Native configuration could not be parsed. Preserve it and correct the native profile first.'); }
}
function hermesEnvironment(home: string): NodeJS.ProcessEnv {
  return home === resolve(process.env.HERMES_HOME ?? join(homedir(), '.hermes')) ? process.env : {};
}
function envValues(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?(A2A_[A-Z0-9_]+|ENVAR_A2A_[A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    let value = match[2]!;
    if (value.startsWith('"')) { try { value = JSON.parse(value); } catch { throw new Error('Invalid A2A environment value'); } }
    else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
    result[match[1]!] = value;
  }
  return result;
}
function changeEnv(text: string, changes: Record<string, string>): string {
  let result = text;
  for (const [key, value] of Object.entries(changes)) {
    const line = key + '=' + JSON.stringify(value);
    const pattern = new RegExp('^\\s*(?:export\\s+)?' + key + '\\s*=.*$', 'gm');
    result = pattern.test(result) ? result.replace(pattern, () => line) : result.trimEnd() + '\n' + line + '\n';
  }
  return result;
}
function writeProfile(path: string, text: string, backupRoot: string): boolean {
  const before = readProfile(path);
  if (before === text) return false;
  if (existsSync(path)) writePrivate(join(backupRoot, randomUUID() + '-' + basename(path)), before);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (lstatSync(dirname(path)).isSymbolicLink()) throw new Error('Native profile directory must not be a symlink');
  const temp = join(dirname(path), '.envar-write-' + randomUUID());
  writeFileSync(temp, text, { mode: 0o600, flag: 'wx', flush: true }); renameSync(temp, path); return true;
}
export interface NativeInspection {
  home: string; configFile: string; port: number; agentId: string; cardUrl: string; binary: string[]; runtimeVersion: string;
}
export function inspectNative(framework: 'hermes' | 'openclaw', options: {
  home?: string; nativeAgent?: string; cardUrl?: string;
  versionProbe?: (binary: string[], env: NodeJS.ProcessEnv) => string;
} = {}): NativeInspection {
  const overrideFile = framework === 'openclaw' && !options.home ? process.env.OPENCLAW_CONFIG_PATH : undefined;
  const home = resolve(options.home ?? (overrideFile ? dirname(resolve(overrideFile)) : undefined) ?? (framework === 'hermes' ? process.env.HERMES_HOME ?? join(homedir(), '.hermes')
    : process.env.OPENCLAW_STATE_DIR ?? join(homedir(), '.openclaw')));
  const file = overrideFile ? resolve(overrideFile) : join(home, framework === 'hermes' ? 'config.yaml' : 'openclaw.json');
  if (process.getuid?.() === 0 && existsSync(home) && lstatSync(home).uid !== 0)
    throw new Error('Run the Connector as the same user as the native Agent. For the official Hermes Docker image, open a shell with docker exec --user hermes -e HOME=/opt/data -it CONTAINER sh, then run the setup command there.');
  const config = readConfig(file, framework === 'hermes');
  const env = envValues(readProfile(join(home, '.env')));
  let nativeAgent = options.nativeAgent ?? 'main', port = 9900, origin = '';
  if (framework === 'hermes') {
    if (options.nativeAgent && options.nativeAgent !== 'main') throw new Error('Select the Hermes profile with --home; its local A2A gateway uses that profile');
    const active = hermesEnvironment(home);
    port = Number(active.A2A_PORT ?? env.A2A_PORT ?? config.platforms?.a2a?.extra?.port ?? config.gateway?.platforms?.a2a?.extra?.port ?? 9900);
    origin = active.A2A_PUBLIC_URL ?? env.A2A_PUBLIC_URL ?? '';
  } else {
    const entries = object(config.agents?.entries);
    const legacy = config.agents?.list;
    const ids: string[] = Object.keys(entries).length ? Object.keys(entries) : Array.isArray(legacy) ? legacy.map((agent: RecordValue) => agent.id) : [];
    const selected = Array.isArray(legacy) ? legacy.find((agent: RecordValue) => agent.default)?.id : undefined;
    if (!options.nativeAgent && ids.length > 1 && !selected) throw new Error('This OpenClaw has multiple Agents. Choose the intended one with --native-agent ID.');
    nativeAgent = options.nativeAgent ?? selected ?? ids[0] ?? 'main';
    if (ids.length && !ids.includes(nativeAgent)) throw new Error('Choose an existing OpenClaw agent ID');
    port = Number(config.gateway?.port ?? 18789);
    origin = config.channels?.a2a?.advertisedUrl ?? '';
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(nativeAgent))
    throw new Error('Invalid native Agent or A2A port');
  const cardUrl = options.cardUrl ?? new URL('.well-known/agent-card.json', (origin || `http://127.0.0.1:${port}`).replace(/\/$/, '') + '/').href;
  validateUrl(cardUrl, true);
  const binary = framework === 'hermes' ? [existsSync('/opt/hermes/bin/hermes') ? '/opt/hermes/bin/hermes' : 'hermes']
    : existsSync('/app/openclaw.mjs') ? [process.execPath, '/app/openclaw.mjs'] : ['openclaw'];
  const runtimeEnv = { ...process.env, ...(framework === 'hermes' ? { HERMES_HOME: home } : { OPENCLAW_STATE_DIR: home }) };
  let output: string;
  try { output = options.versionProbe ? options.versionProbe(binary, runtimeEnv)
    : execFileSync(binary[0]!, [...binary.slice(1), '--version'], { encoding: 'utf8', env: runtimeEnv, stdio: 'pipe', timeout: 30000, maxBuffer: 65536 }); }
  catch { throw new Error('Cannot inspect the native CLI. Confirm the Agent installation and profile before connecting.'); }
  const runtimeVersion = output.replace(/\x1b\[[0-9;]*m/g, '').match(/\b\d{1,4}\.\d+(?:\.[0-9A-Za-z.+-]+)?/)?.[0] ?? 'unknown';
  return { home, configFile: file, port, agentId: nativeAgent, cardUrl, binary, runtimeVersion };
}

export function configureNative(directory: string, config: ConnectorConfig): boolean {
  const home = config.runtime.home, yaml = config.framework === 'hermes';
  const path = config.runtime.configFile ?? join(home, yaml ? 'config.yaml' : 'openclaw.json');
  const value = readConfig(path, yaml), envPath = join(home, '.env'), envText = readProfile(envPath), env = envValues(envText);
  const nativeTokenFile = join(directory, 'native.token');
  const token = existsSync(nativeTokenFile) ? privateText(nativeTokenFile).trim() : randomBytes(32).toString('base64url');
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) throw new Error('Restore the original private native peer credential');
  if (!existsSync(nativeTokenFile)) writePrivate(nativeTokenFile, token + '\n');
  const markerFile = join(directory, 'native-binding.json');
  const previous = existsSync(markerFile) ? privateJson<{ agentId: string; home: string; mcpDigest: string; connectorVersion?: string }>(markerFile) : undefined;
  if (previous && (previous.agentId !== config.agentId || previous.home !== home)) throw new Error('Native binding belongs to another Agent or profile');
  const cli = fileURLToPath(new URL('../cli.js', import.meta.url));
  const mcp = { command: process.execPath, args: [cli, 'connector', 'mcp', '--directory', directory, '--connection', config.connectionId],
    ...(yaml ? { timeout: 70 } : { enabled: true, requestTimeoutMs: 70000 }) };
  const servers = yaml ? object(value.mcp_servers) : object(object(value.mcp).servers);
  const existing = servers[config.runtime.mcpName];
  if (existing && digest(existing) !== digest(mcp) && (!previous || digest(existing) !== previous.mcpDigest))
    throw new Error('The existing Envar MCP entry was edited. Preserve it and review its configuration before replacing it.');
  servers[config.runtime.mcpName] = mcp;
  const changes: Record<string, string> = {};
  const origin = config.runtime.cardUrl.replace(/\/\.well-known\/agent-card\.json$/, '');
  if (yaml) {
    value.mcp_servers = servers;
    const platforms = object(value.platforms), legacy = object(object(value.gateway).platforms);
    const a2a = object(platforms.a2a ?? legacy.a2a);
    platforms.a2a = { ...a2a, enabled: true, extra: { ...object(a2a.extra), port: config.runtime.port ?? a2a.extra?.port ?? 9900 } };
    value.platforms = platforms;
    const active = hermesEnvironment(home);
    const peers = active.A2A_PEER_TOKENS ?? env.A2A_PEER_TOKENS ?? '';
    const own = peers.split(',').find(item => item.trim().startsWith(config.runtime.peerName + ':'))?.trim();
    if (own && own.slice(config.runtime.peerName.length + 1) !== token) throw new Error('Existing native peer credential differs; restore the original Connector directory');
    changes.A2A_PEER_TOKENS = own ? peers : [peers, config.runtime.peerName + ':' + token].filter(Boolean).join(',');
    const trusted = (active.A2A_TRUSTED_PEERS ?? env.A2A_TRUSTED_PEERS ?? '').split(',').map(v => v.trim()).filter(Boolean);
    changes.A2A_TRUSTED_PEERS = [...new Set([...trusted, config.runtime.peerName])].join(',');
    if (!active.A2A_PUBLIC_URL && !env.A2A_PUBLIC_URL) changes.A2A_PUBLIC_URL = origin;
    // Environment overrides cannot be silently changed by writing a profile file.
    for (const key of ['A2A_PEER_TOKENS', 'A2A_TRUSTED_PEERS']) {
      if (active[key] && active[key] !== changes[key]) throw new Error('A2A peer settings are supplied by the deployment environment. Add this Connector through that environment before continuing.');
    }
  } else {
    value.mcp = { ...object(value.mcp), servers };
    const channels = object(value.channels), a2a = object(channels.a2a), peers = object(a2a.peers);
    const key = 'ENVAR_A2A_' + config.agentId.replaceAll('-', '').toUpperCase();
    if ((process.env[key] ?? env[key]) && (process.env[key] ?? env[key]) !== token) throw new Error('The managed native peer environment key already has another value');
    const reference = '${' + key + '}';
    if (peers[config.runtime.peerName]?.token && peers[config.runtime.peerName].token !== reference)
      throw new Error('Existing native peer credential differs; preserve its configuration');
    peers[config.runtime.peerName] = { ...object(peers[config.runtime.peerName]), token: reference };
    channels.a2a = { ...a2a, enabled: true, peers, advertisedUrl: a2a.advertisedUrl || origin,
      ...(!a2a.enabled && a2a.exposeAgents === undefined ? { exposeAgents: [config.runtime.agentId] } : {}) };
    value.channels = channels; changes[key] = token;
    const bindings = value.bindings ?? [];
    if (!Array.isArray(bindings)) throw new Error('Native bindings must remain an array');
    const prior = bindings.find((b: RecordValue) => b.match?.channel === 'a2a' && b.match?.peer?.id === config.runtime.peerName);
    if (prior && prior.agentId !== config.runtime.agentId) throw new Error('This peer is already routed to another native Agent');
    if (!prior) bindings.push({ agentId: config.runtime.agentId, match: { channel: 'a2a', peer: { kind: 'direct', id: config.runtime.peerName } } });
    value.bindings = bindings;
  }
  const backupRoot = join(directory, 'native-backups');
  const envChanged = writeProfile(envPath, changeEnv(envText, changes), backupRoot);
  const configChanged = writeProfile(path, yaml ? stringifyYaml(value) : JSON.stringify(value, null, 2) + '\n', backupRoot);
  writePrivateJson(markerFile, { agentId: config.agentId, home, mcpDigest: digest(mcp), connectorVersion });
  return envChanged || configChanged || previous?.connectorVersion !== connectorVersion;
}
