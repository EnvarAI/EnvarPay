import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw new Error('Use a private Connector directory (mode 700)');
}
export function privateText(path: string): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.size > 1024 * 1024)
    throw new Error('Use a bounded owner-only Connector file (mode 600)');
  return readFileSync(path, 'utf8');
}
export function privateJson<T>(path: string): T {
  const text = privateText(path);
  try { return JSON.parse(text) as T; }
  catch { throw new Error('The private Connector file is invalid. Preserve it and inspect the configuration.'); }
}
export function writePrivate(path: string, text: string): void {
  privateDirectory(dirname(path));
  if (existsSync(path)) privateText(path);
  const temporary = join(dirname(path), '.write-' + randomUUID());
  writeFileSync(temporary, text, { flag: 'wx', mode: 0o600, flush: true });
  renameSync(temporary, path);
}
export function writePrivateJson(path: string, value: unknown): void { writePrivate(path, JSON.stringify(value, null, 2) + '\n'); }
