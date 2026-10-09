import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from 'yaml';
const namePattern = /^[a-z][a-z0-9-]{0,63}$/;

export function readSkillInventory(roots: string[]) {
  const found: { name: string; path: string; description: string; supported: boolean; digest: string; files: number }[] = [];
  const seen = new Set<string>();
  function visit(folder: string, depth: number) {
    if (depth > 10 || found.length >= 128 || !existsSync(folder)) return;
    const stat = lstatSync(folder);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    const entry = join(folder, 'SKILL.md');
    if (!existsSync(entry)) {
      for (const child of readdirSync(folder).sort()) if (!child.startsWith('.')) visit(join(folder, child), depth + 1);
      return;
    }
    const info = lstatSync(entry);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 48000) return;
    const raw = readFileSync(entry, 'utf8'), header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw)?.[1];
    let meta: { name?: string; description?: unknown };
    try { meta = parse(header ?? '') ?? {}; } catch { return; }
    if (typeof meta.name !== 'string' || !namePattern.test(meta.name) || seen.has(meta.name)) return;
    const files: [string, string][] = []; let size = 0, supported = true;
    function collect(path: string, prefix = '', level = 0) {
      if (level > 10) { supported = false; return; }
      for (const name of readdirSync(path).sort()) {
        const file = join(path, name), s = lstatSync(file);
        if (s.isSymbolicLink()) { supported = false; continue; }
        if (s.isDirectory()) { collect(file, prefix + name + '/', level + 1); continue; }
        if (!s.isFile() || s.size > 512 * 1024 || (size += s.size) > 1024 * 1024 || files.length >= 128) { supported = false; continue; }
        if (!['.md', '.txt'].includes(extname(name).toLowerCase()) && name !== 'LICENSE') supported = false;
        files.push([prefix + name, createHash('sha256').update(readFileSync(file)).digest('hex')]);
      }
    }
    collect(folder); files.sort((a,b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
    const canonical = JSON.stringify(files).replace(/[\u007f-\uffff]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
    seen.add(meta.name);
    found.push({ name: meta.name, path: resolve(folder), description: String(meta.description ?? '').slice(0, 500), supported, digest: createHash('sha256').update(canonical).digest('hex'), files: files.length });
  }
  for (const root of roots.slice(0, 16)) if (typeof root === 'string') visit(resolve(root.replace(/^~(?=\/|$)/, homedir())), 0);
  return found;
}
