/** A persistent native-runtime host for the existing seller CLI. No wallet authority is added. */
import { chownSync, closeSync, existsSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { CommerceError } from './types.js';

const idPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
function rootDirectory(root: string) {
  const path = resolve(root), stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw new CommerceError('managed_directory', 'Use the existing private managed EnvarPay directory');
  return path;
}
export function managedProfile(root: string): string {
  const base = rootDirectory(root), file = join(base, 'active-profile.json');
  const profiles = join(base, 'profiles');
  if (existsSync(profiles)) {
    const stat = lstatSync(profiles);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw new CommerceError('managed_profile', 'Use a private profile directory without links');
  }
  if (!existsSync(file)) return base;
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 || (stat.mode & 0o077)) throw new CommerceError('managed_profile', 'Invalid managed profile');
  const value = JSON.parse(readFileSync(file, 'utf8'));
  if (value.version !== 1 || !idPattern.test(value.agentId)) throw new CommerceError('managed_profile', 'Invalid managed Agent identity');
  const path = join(base, 'profiles', value.agentId), p = lstatSync(path);
  if (!p.isDirectory() || p.isSymbolicLink() || (p.mode & 0o077)) throw new CommerceError('managed_profile', 'Use the original private profile');
  return path;
}
export function activateManagedProfile(root: string, agentId: string, profile: string) {
  const base = rootDirectory(root);
  if (!idPattern.test(agentId) || resolve(profile) !== join(base, 'profiles', agentId)) throw new CommerceError('managed_profile', 'Profile does not belong to this managed Agent');
  const previous = managedProfile(base);
  if (previous !== base && previous !== resolve(profile)) throw new CommerceError('managed_bound', 'This runtime is already bound to another Agent; preserve its ledger');
  if (previous === base) {
    const config = JSON.parse(readFileSync(join(base, 'seller.json'), 'utf8'));
    if (config.services?.length || Object.keys(config.paymentProfiles ?? {}).length) throw new CommerceError('managed_in_use', 'Existing seller configuration requires review');
    const ledger = join(base, 'seller.sqlite3');
    if (existsSync(ledger)) {
      const db = new DatabaseSync(ledger, { readOnly: true });
      try {
        for (const table of ['commerce_orders', 'commerce_service_revisions']) {
          if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table) && Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n)) throw new CommerceError('managed_in_use', 'Keep the existing seller ledger and inspect its operations before connecting');
        }
      } finally { db.close(); }
    }
  }
  const owner = lstatSync(base);
  function ownership(path: string) {
    const s = lstatSync(path);
    if (s.isSymbolicLink() || (!s.isDirectory() && !s.isFile())) throw new CommerceError('managed_profile', 'Managed profiles cannot contain links or special files');
    if (process.getuid?.() === 0) chownSync(path, owner.uid, owner.gid);
    if (s.isDirectory()) for (const name of readdirSync(path)) ownership(join(path, name));
  }
  ownership(join(base, 'profiles'));
  const connection = JSON.parse(readFileSync(join(profile, 'connection.json'), 'utf8'));
  if (connection.agentId !== agentId) throw new CommerceError('managed_profile', 'Connection belongs to another Agent');
  if (previous === resolve(profile)) return;
  const temp = join(base, `.active-${process.pid}.json`);
  writeFileSync(temp, JSON.stringify({ version: 1, agentId }), { mode: 0o600, flag: 'wx', flush: true });
  if (process.getuid?.() === 0) chownSync(temp, owner.uid, owner.gid);
  try {
    // Atomic create prevents two setup processes from replacing one another's binding.
    linkSync(temp, join(base, 'active-profile.json'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || managedProfile(base) !== resolve(profile)) throw new CommerceError('managed_bound', 'This runtime was bound by another setup; preserve its original profile');
  } finally { unlinkSync(temp); }
  const directory = openSync(base, 'r');
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

export async function serveManaged(root: string, origin: string, host: string, port: number): Promise<void> {
  const base = rootDirectory(root), cli = fileURLToPath(new URL('./cli.js', import.meta.url));
  let child: ChildProcess | undefined, stopping = false;
  const stop = () => { stopping = true; child?.kill('SIGTERM'); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  try {
    while (!stopping) {
      const profile = managedProfile(base);
      const stamp = () => ['credentials.json', 'envar.json', 'envar.token'].map(name => { const p = join(profile, name); return existsSync(p) ? lstatSync(p).mtimeMs : 0; }).join(':');
      const initialStamp = stamp();
      const args = [cli, 'serve', '--config', join(profile, 'seller.json'), '--credentials', join(profile, 'credentials.json'), '--state', join(profile, 'seller.sqlite3'), '--origin', origin, '--host', host, '--port', String(port)];
      if (profile !== base) args.push('--envar-config', join(profile, 'envar.json'), '--envar-credentials', join(profile, 'envar.token'));
      child = spawn(process.execPath, args, { stdio: 'inherit' });
      let switching = false;
      const timer = setInterval(() => {
        try { if (!switching && (managedProfile(base) !== profile || stamp() !== initialStamp)) { switching = true; child?.kill('SIGTERM'); } }
        catch { stop(); }
      }, 1000);
      try {
        const [code] = await once(child, 'exit');
        if (!stopping && !switching) throw new CommerceError('managed_runtime_exit', `Seller stopped (${code}); keep its profile and inspect its configuration`);
      } finally { clearInterval(timer); }
    }
  } finally { process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); }
}
