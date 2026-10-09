/** Read local OpenClaw configuration and installed Skill metadata without invoking a model. */
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readSkillInventory } from './native-inventory.js';
import { CommerceError } from './types.js';

function configuration(home?: string) {
  const path = home ? join(resolve(home), 'openclaw.json') : process.env.OPENCLAW_CONFIG_PATH ?? join(process.env.OPENCLAW_STATE_DIR ?? join(homedir(), '.openclaw'), 'openclaw.json');
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new CommerceError('setup_model', 'Use a bounded local OpenClaw configuration file');
  return { home: dirname(resolve(path)), config: JSON.parse(readFileSync(path, 'utf8')) };
}

export function openclawRoots(home?: string): string[] {
  const local = configuration(home), config = local.config, defaults = config.agents?.defaults ?? {};
  const agent = config.agents?.list?.find((a: { id?: string; default?: boolean }) => a.default || a.id === 'main');
  return [join(local.home, 'skills'), join(agent?.workspace ?? defaults.workspace ?? join(local.home, 'workspace'), 'skills'), ...(config.skills?.load?.extraDirs ?? [])].filter((r): r is string => typeof r === 'string');
}
export function openclawInventory(home?: string) { return readSkillInventory(openclawRoots(home)); }

export function probeOpenClaw(home?: string, python = 'python3') {
  const local = configuration(home), config = local.config;
  const agent = config.agents?.list?.find((a: { id?: string; default?: boolean }) => a.default || a.id === 'main');
  const selected = agent?.model ?? config.agents?.defaults?.model;
  const primary = typeof selected === 'string' ? selected : selected?.primary;
  if (typeof primary !== 'string' || !primary.includes('/')) throw new CommerceError('setup_model', 'Configure an OpenAI-compatible OpenClaw model first');
  const slash = primary.indexOf('/'), provider = config.models?.providers?.[primary.slice(0, slash)], model = primary.slice(slash + 1);
  let key = provider?.apiKey;
  if (typeof key === 'string') {
    const env = /^\$\{([A-Z_][A-Z0-9_]*)\}$/.exec(key);
    if (env) key = process.env[env[1]];
  } else if (key?.source === 'env' && typeof key.id === 'string') key = process.env[key.id];
  if (typeof key !== 'string' || !key.trim() || typeof provider?.baseUrl !== 'string' || (provider.api ?? 'openai-completions') !== 'openai-completions') throw new CommerceError('setup_model', 'Use an OpenAI-compatible provider with a locally available API key');
  const command = existsSync('/app/openclaw.mjs') ? [process.execPath, '/app/openclaw.mjs'] : ['openclaw'];
  execFileSync(python, ['--version'], { stdio: 'pipe', timeout: 10000 });
  execFileSync(command[0], [...command.slice(1), '--version'], { stdio: 'pipe', timeout: 30000 });
  return { home: local.home, python, command, model, baseUrl: provider.baseUrl, apiKeyFile: null, apiKey: key, skillRoots: openclawRoots(local.home), skills: openclawInventory(local.home).map(s => ({ ...s, textPackage: s.supported })) };
}
