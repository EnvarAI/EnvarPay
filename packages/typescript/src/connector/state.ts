/** Owner-only durable journal. Transport receipts never imply a second execution. */
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { Claim, Delivery, Report, Work } from './contracts.generated.js';
import type { RuntimeObservation, RuntimeReference } from '../adapters/types.js';

export type Phase = 'prepared' | 'claimed' | 'admitted' | 'dispatching' | 'running' | 'waiting_input' | 'report_pending' | 'unknown' | 'terminal';
export interface LocalWork {
  work: Work; deliveryId: number; phase: Phase; claimRequestId: string;
  claim?: Claim & { lease_until: string | null }; reference?: RuntimeReference;
  pendingReport?: Report; afterReport?: Phase; observation?: RuntimeObservation; lastObservation?: string; error?: string;
}
export interface LocalControl {
  deliveryId: number; operationId: string;
  phase: 'prepared' | 'dispatching' | 'observed' | 'unknown' | 'unsupported' | 'reported';
  observation?: RuntimeObservation; text?: string;
}
export interface ConnectorBinding { origin: string; agentId: string; connectionId: string; adapter: string; cardUrl: string; }
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function parseStored<T>(value: string): T {
  try { return JSON.parse(value) as T; }
  catch { throw new Error('A Connector journal record is unreadable. Preserve the original state before recovery.'); }
}
function privateFile(path: string) {
  const s = lstatSync(path);
  if (!s.isFile() || s.isSymbolicLink() || (s.mode & 0o077)) throw new Error('Use an owner-only regular Connector file');
}
export class ConnectorJournal {
  private readonly db: DatabaseSync;
  private lock?: { path: string; nonce: string };
  constructor(path: string, readonly binding: ConnectorBinding) {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const directory = lstatSync(dirname(path));
      if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077)) throw new Error('Use a private Connector directory');
      if (existsSync(path)) privateFile(path);
    }
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS connector_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS connector_work (id TEXT PRIMARY KEY,phase TEXT NOT NULL,value TEXT NOT NULL,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS connector_delivery (id INTEGER PRIMARY KEY,kind TEXT NOT NULL,value TEXT NOT NULL,acked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS connector_outgoing (id TEXT PRIMARY KEY,request TEXT NOT NULL,work TEXT);
      CREATE TABLE IF NOT EXISTS connector_control (id INTEGER PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS connector_order_request (id TEXT PRIMARY KEY,request TEXT NOT NULL,order_id TEXT);
      CREATE INDEX IF NOT EXISTS connector_work_phase ON connector_work(phase,created);`);
    const existing = this.db.prepare("SELECT value FROM connector_meta WHERE key='binding'").get();
    if (existing && existing.value !== JSON.stringify(binding)) { this.db.close(); throw new Error('This journal belongs to another Agent or runtime binding'); }
    this.db.prepare("INSERT OR IGNORE INTO connector_meta VALUES ('binding',?)").run(JSON.stringify(binding));
  }
  /** A stale process can be replaced only after proving that PID no longer exists. */
  acquireProcessLock(path: string): void {
    if (this.lock) throw new Error('Connector already owns a process lock');
    if (existsSync(path)) {
      privateFile(path);
      const value = parseStored<{ pid: number; nonce: string }>(readFileSync(path, 'utf8'));
      if (!Number.isSafeInteger(value.pid) || value.pid < 1) throw new Error('Inspect the original Connector lock');
      try { process.kill(value.pid, 0); throw new Error('Another Connector process is using this journal'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      unlinkSync(path);
    }
    const nonce = randomUUID(), fd = openSync(path, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify({ pid: process.pid, nonce }), { flush: true }); }
    finally { closeSync(fd); }
    this.lock = { path, nonce };
  }
  ingest(delivery: Delivery): void {
    const work = delivery.work;
    const incoming = ['work', 'input', 'cancel'].includes(delivery.kind);
    if (incoming ? work.target_agent_id !== this.binding.agentId || work.connection_id !== this.binding.connectionId
      : work.caller_agent_id !== this.binding.agentId) throw new Error('Inbox delivery belongs to another Agent');
    const old = this.db.prepare('SELECT value FROM connector_delivery WHERE id=?').get(delivery.id);
    if (old) {
      const saved = parseStored<Delivery>(String(old.value));
      if (saved.kind !== delivery.kind || saved.work.id !== work.id || digest(saved.event) !== digest(delivery.event))
        throw new Error('Delivery identity changed');
    }
    this.db.prepare('INSERT INTO connector_delivery(id,kind,value) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value')
      .run(delivery.id, delivery.kind, JSON.stringify(delivery));
    if (delivery.kind === 'work') {
      const prior = this.get(work.id);
      if (prior && digest([prior.work.target_agent_id, prior.work.connection_id, prior.work.context_id, prior.work.request]) !==
          digest([work.target_agent_id, work.connection_id, work.context_id, work.request])) throw new Error('Work request changed');
      if (!prior) this.save({ work, deliveryId: delivery.id, phase: 'prepared', claimRequestId: randomUUID() });
    }
  }
  save(record: LocalWork): void {
    this.db.prepare('INSERT INTO connector_work VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET phase=excluded.phase,value=excluded.value')
      .run(record.work.id, record.phase, JSON.stringify(record), Date.now());
  }
  get(id: string): LocalWork | undefined {
    const row = this.db.prepare('SELECT value FROM connector_work WHERE id=?').get(id);
    return row ? parseStored<LocalWork>(String(row.value)) : undefined;
  }
  pending(): LocalWork[] {
    return this.db.prepare("SELECT value FROM connector_work WHERE phase!='terminal' ORDER BY created,id").all()
      .map(row => parseStored<LocalWork>(String(row.value)));
  }
  deliveries(): Delivery[] {
    return this.db.prepare('SELECT value FROM connector_delivery WHERE acked=0 ORDER BY id').all()
      .map(row => parseStored<Delivery>(String(row.value)));
  }
  results(): Delivery[] {
    return this.db.prepare("SELECT value FROM connector_delivery WHERE kind IN ('result','input_required') ORDER BY id DESC LIMIT 50")
      .all().map(row => parseStored<Delivery>(String(row.value)));
  }
  acknowledge(id: number): void { this.db.prepare('UPDATE connector_delivery SET acked=1 WHERE id=?').run(id); }
  outgoing(requestId: string, request: unknown): Work | undefined {
    const encoded = JSON.stringify(request);
    const row = this.db.prepare('SELECT request,work FROM connector_outgoing WHERE id=?').get(requestId);
    if (row) {
      if (row.request !== encoded) throw new Error('Request ID already belongs to another outgoing task');
      return row.work ? parseStored<Work>(String(row.work)) : undefined;
    }
    this.db.prepare('INSERT INTO connector_outgoing(id,request) VALUES (?,?)').run(requestId, encoded);
    return undefined;
  }
  saveOutgoing(requestId: string, work: Work): void {
    this.db.prepare('UPDATE connector_outgoing SET work=? WHERE id=?').run(JSON.stringify(work), requestId);
  }
  orderRequest(requestId: string, request: unknown): string | undefined {
    const encoded = JSON.stringify(request);
    const row = this.db.prepare('SELECT request,order_id FROM connector_order_request WHERE id=?').get(requestId);
    if (row) {
      if (row.request !== encoded) throw new Error('Request ID already belongs to another original service quote');
      return row.order_id ? String(row.order_id) : undefined;
    }
    this.db.prepare('INSERT INTO connector_order_request(id,request) VALUES (?,?)').run(requestId, encoded);
    return undefined;
  }
  saveOrderRequest(requestId: string, orderId: string): void {
    const row = this.db.prepare('SELECT order_id FROM connector_order_request WHERE id=?').get(requestId);
    if (!row || (row.order_id && row.order_id !== orderId)) throw new Error('Preserve the original service quote request');
    this.db.prepare('UPDATE connector_order_request SET order_id=? WHERE id=?').run(orderId, requestId);
  }
  control(deliveryId: number): LocalControl {
    const row = this.db.prepare('SELECT value FROM connector_control WHERE id=?').get(deliveryId);
    if (row) return parseStored<LocalControl>(String(row.value));
    const created: LocalControl = { deliveryId, operationId: randomUUID(), phase: 'prepared' };
    this.saveControl(created); return created;
  }
  saveControl(control: LocalControl): void {
    this.db.prepare('INSERT INTO connector_control VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value')
      .run(control.deliveryId, JSON.stringify(control));
  }
  queueReport(record: LocalWork, kind: Report['kind'], text: string, afterReport: Phase, observation?: unknown, eventId: string = randomUUID()): void {
    if (!record.claim || record.pendingReport) throw new Error('Preserve the pending report before queuing another');
    record.pendingReport = { claim: { id: record.claim.id, fence: record.claim.fence }, event_id: eventId, kind, text };
    record.afterReport = afterReport; record.phase = 'report_pending';
    record.lastObservation = observation === undefined ? undefined : digest(observation);
    this.save(record);
  }
  sameObservation(record: LocalWork, observation: unknown): boolean { return record.lastObservation === digest(observation); }
  close(): void {
    this.db.close();
    if (this.lock && existsSync(this.lock.path)) {
      privateFile(this.lock.path);
      const value = parseStored<{ pid: number; nonce: string }>(readFileSync(this.lock.path, 'utf8'));
      if (value.nonce === this.lock.nonce) unlinkSync(this.lock.path);
    }
    this.lock = undefined;
  }
}
