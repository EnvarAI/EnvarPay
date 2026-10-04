import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, chmodSync, openSync, closeSync, fsyncSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { CommerceError } from './types.js';

/** Original authorizations are encrypted before any external settlement attempt. */
export class CredentialVault {
  private readonly key: Buffer;
  constructor(private directory: string, key: Buffer) {
    if (key.length !== 32) throw new CommerceError('vault_key', 'A 32-byte vault encryption key is required');
    this.key = Buffer.from(key);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!lstatSync(directory).isDirectory()) throw new CommerceError('vault_directory', 'Vault must be a real directory');
    chmodSync(directory, 0o700);
  }
  put(value: unknown): string {
    const serialized = JSON.stringify(value);
    if (!serialized || Buffer.byteLength(serialized) > 65536) throw new CommerceError('vault_size', 'Authorization exceeds vault limit');
    const id = randomUUID(), nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(Buffer.from(id));
    const encrypted = Buffer.concat([cipher.update(serialized, 'utf8'), cipher.final()]);
    writeFileSync(join(this.directory, id), Buffer.concat([nonce, cipher.getAuthTag(), encrypted]), { mode: 0o600, flag: 'wx', flush: true });
    // Persist the directory entry before returning a reference to the ledger.
    const directoryFd = openSync(this.directory, 'r');
    try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
    return id;
  }
  get(id: string): unknown {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) throw new CommerceError('vault_reference', 'Invalid credential reference');
    const path = join(this.directory, id), stat = lstatSync(path);
    if (!stat.isFile() || stat.size < 29 || stat.size > 65564 || (stat.mode & 0o077) !== 0) throw new CommerceError('vault_file', 'Invalid private authorization file');
    const bytes = readFileSync(path);
    const cipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
    cipher.setAAD(Buffer.from(id)); cipher.setAuthTag(bytes.subarray(12, 28));
    try { return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8')); }
    catch { throw new CommerceError('vault_integrity', 'Original authorization failed integrity verification'); }
  }
}
