import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PaymentRequired, PaymentRequirements, SettleResponse } from '@x402/core/types';
import { atomic } from './config.js';
import type { Challenge } from 'mppx';
import type { MppReceipt } from './mpp-client.js';
import { CommerceError, type BuyerPolicy, type Input } from './types.js';

export interface BuyerQuote {
  messageId: string; payer: string; amount: string; currency: string | null; recipient: string | null;
  expiresAt: string; serviceId: string; serviceRevision: number; offerId: string;
  inputDigest: string; termsDigest: string; quoteId: string;
  /** Absent for the original seller-advertised EnvarPay contract. */
  termsSource?: 'local-policy';
}
export interface BuyerRecord {
  id: string; caller: string; peerId: string; cardUrl: string; endpoint: string;
  messageId: string; fingerprint: string; body: string; quoteToken: string; quote: BuyerQuote;
  input: Input; inputSchema: Record<string, unknown>;
  peerMode?: 'standard-a2a';
  standardBinding?: { policyDigest: string; bodyDigest: string; challengeDigest: string };
  continuations?: { messageId: string; input: Input; body?: string; state: 'pending' | 'unknown' | 'resolved'; beforeDigest: string }[];
  protocol?: 'x402' | 'mpp' | 'free'; mppChallenge?: Challenge.Challenge; tokenOperationId?: string; tokenRef?: string; mppMode?: 'test' | 'live'; mppPaymentMethod?: string;
  required?: PaymentRequired; requirements?: PaymentRequirements; createdAt: string; updatedAt: string;
  state: 'previewed' | 'signing' | 'submitted' | 'unknown' | 'completed' | 'failed';
  paymentState: 'quoted' | 'reserved' | 'unknown' | 'confirmed' | 'rejected' | 'not_required'; executionState: string;
  credentialRef?: string; nonce?: string; fromBlock?: string; receipt?: SettleResponse | MppReceipt;
  task?: Record<string, unknown>; result?: unknown; errorCode?: string;
  rejectionEvidence?: { kind: 'finalized_expired_unused'; checkedAt: string; nonce: string };
}

/** One wallet ledger, one process. Unknown authorizations retain cumulative budget. */
export class BuyerStore {
  private readonly db: DatabaseSync;
  private readonly owner?: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      this.owner = new DatabaseSync(path + '.owner.sqlite3');
      chmodSync(path + '.owner.sqlite3', 0o600);
      try { this.owner.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE'); }
      catch { this.owner.close(); throw new CommerceError('store_locked', 'Buyer ledger already has an active process'); }
    }
    try {
      this.db = new DatabaseSync(path);
      if (path !== ':memory:') chmodSync(path, 0o600);
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS buyer_meta(version INTEGER NOT NULL);
        INSERT INTO buyer_meta SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM buyer_meta);
        CREATE TABLE IF NOT EXISTS buyer_purchases(
          id TEXT PRIMARY KEY, caller TEXT NOT NULL, message_id TEXT NOT NULL,
          currency TEXT NOT NULL, amount TEXT NOT NULL, budget_state TEXT NOT NULL,
          record_json TEXT NOT NULL, UNIQUE(caller,message_id), UNIQUE(message_id)
        );`);
      if (this.db.prepare('SELECT version FROM buyer_meta').get()?.version !== 1) throw new CommerceError('store_version', 'Unsupported buyer ledger version');
      // Never resume signing after a crash: no second nonce may be created.
      for (const row of this.db.prepare('SELECT record_json FROM buyer_purchases').all()) {
        const record = JSON.parse(String(row.record_json)) as BuyerRecord;
        if (record.state === 'signing' || record.state === 'submitted') this.update(record.id, { state: 'unknown', paymentState: ['confirmed', 'not_required'].includes(record.paymentState) ? record.paymentState : 'unknown', errorCode: 'interrupted_purchase' });
      }
    } catch (error) { this.owner?.close(); throw error; }
  }
  close(): void { this.db.close(); if (this.owner) { this.owner.exec('ROLLBACK'); this.owner.close(); } }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  get(id: string, caller: string): BuyerRecord | undefined {
    const row = this.db.prepare('SELECT record_json FROM buyer_purchases WHERE id=? AND caller=?').get(id, caller);
    return row ? JSON.parse(String(row.record_json)) : undefined;
  }
  assertMessageOwner(caller: string, messageId: string): void {
    const row = this.db.prepare('SELECT caller FROM buyer_purchases WHERE message_id=?').get(messageId);
    if (row && row.caller !== caller) throw new CommerceError('purchase_conflict', 'Message ID is already reserved to another caller');
  }
  find(caller: string, messageId: string): BuyerRecord | undefined {
    const row = this.db.prepare('SELECT record_json FROM buyer_purchases WHERE caller=? AND message_id=?').get(caller, messageId);
    return row ? JSON.parse(String(row.record_json)) : undefined;
  }
  insert(value: Omit<BuyerRecord, 'id' | 'createdAt' | 'updatedAt' | 'state' | 'paymentState' | 'executionState'>): BuyerRecord {
    return this.transaction(() => {
      this.assertMessageOwner(value.caller, value.messageId);
      const prior = this.find(value.caller, value.messageId);
      if (prior) {
        if (prior.fingerprint !== value.fingerprint) throw new CommerceError('purchase_conflict', 'Message ID already identifies another purchase');
        return prior;
      }
      const now = new Date().toISOString();
      const record: BuyerRecord = { ...value, id: randomUUID(), createdAt: now, updatedAt: now, state: 'previewed', paymentState: 'quoted', executionState: 'not_started' };
      this.db.prepare('INSERT INTO buyer_purchases VALUES(?,?,?,?,?,?,?)').run(record.id, record.caller, record.messageId, record.quote.currency ?? '', record.quote.amount, 'none', JSON.stringify(record));
      return record;
    });
  }
  update(id: string, patch: Partial<Pick<BuyerRecord, 'state' | 'paymentState' | 'executionState' | 'credentialRef' | 'nonce' | 'fromBlock' | 'receipt' | 'task' | 'result' | 'errorCode' | 'continuations' | 'tokenOperationId' | 'tokenRef' | 'rejectionEvidence'>>): BuyerRecord {
    const row = this.db.prepare('SELECT record_json FROM buyer_purchases WHERE id=?').get(id);
    if (!row) throw new CommerceError('purchase_not_found', 'Purchase not found');
    const record = { ...JSON.parse(String(row.record_json)), ...patch, updatedAt: new Date().toISOString() } as BuyerRecord;
    this.db.prepare('UPDATE buyer_purchases SET record_json=? WHERE id=?').run(JSON.stringify(record), id);
    return record;
  }
  pendingTasks(): BuyerRecord[] {
    return this.db.prepare('SELECT record_json FROM buyer_purchases').all()
      .map(row => JSON.parse(String(row.record_json)) as BuyerRecord)
      .filter(record => record.task?.id && ['working', 'unknown'].includes(record.executionState));
  }
  usage(currency: string): { reserved: string; spent: string } {
    let reserved = 0n, spent = 0n;
    for (const row of this.db.prepare("SELECT amount,budget_state FROM buyer_purchases WHERE currency=? AND budget_state!='none'").all(currency)) {
      if (row.budget_state === 'spent') spent += BigInt(String(row.amount)); else reserved += BigInt(String(row.amount));
    }
    return { reserved: reserved.toString(), spent: spent.toString() };
  }
  reserve(id: string, caller: string, policy: BuyerPolicy): { record: BuyerRecord; fresh: boolean } {
    return this.transaction(() => {
      const record = this.get(id, caller);
      if (!record) throw new CommerceError('purchase_not_found', 'Purchase not found');
      if (record.state !== 'previewed') return { record, fresh: false };
      const limit = policy.budgets.find(b => b.currency === record.quote.currency);
      const usage = this.usage(record.quote.currency ?? '');
      if (!limit || BigInt(usage.reserved) + BigInt(usage.spent) + atomic(record.quote.amount) > atomic(limit.maxTotal)) throw new CommerceError('budget_exceeded', 'Cumulative wallet budget is exhausted or reserved');
      this.db.prepare("UPDATE buyer_purchases SET budget_state='reserved' WHERE id=?").run(id);
      return { record: this.update(id, { state: 'signing', paymentState: 'reserved' }), fresh: true };
    });
  }
  beginFree(id: string, caller: string): { record: BuyerRecord; fresh: boolean } {
    return this.transaction(() => {
      const record = this.get(id, caller);
      if (!record || record.protocol !== 'free' || record.quote.amount !== '0' || record.quote.currency !== null || record.quote.recipient !== null) throw new CommerceError('free_purchase_binding', 'Invalid original free purchase');
      if (record.state !== 'previewed') return { record, fresh: false };
      return { record: this.update(id, { state: 'submitted', paymentState: 'not_required' }), fresh: true };
    });
  }
  rejectBeforeSigning(id: string, caller: string, errorCode: string): BuyerRecord {
    return this.transaction(() => {
      const record = this.get(id, caller);
      if (!record || record.state !== 'signing' || record.credentialRef || record.nonce) throw new CommerceError('authorization_may_exist', 'Cannot release an existing or ambiguous authorization');
      this.db.prepare("UPDATE buyer_purchases SET budget_state='none' WHERE id=? AND budget_state='reserved'").run(id);
      return this.update(id, { state: 'failed', paymentState: 'rejected', executionState: 'not_started', errorCode });
    });
  }
  rejectExpiredAuthorization(id: string, caller: string): BuyerRecord {
    return this.transaction(() => {
      const record = this.get(id, caller);
      if (!record || record.protocol === 'mpp' || record.protocol === 'free' || !record.credentialRef || !record.nonce) throw new CommerceError('authorization_recovery_required', 'Original x402 authorization is required');
      if (record.paymentState === 'confirmed') return record;
      this.db.prepare("UPDATE buyer_purchases SET budget_state='none' WHERE id=? AND budget_state='reserved'").run(id);
      return this.update(id, { state: 'failed', paymentState: 'rejected', errorCode: 'authorization_expired_unused', rejectionEvidence: { kind: 'finalized_expired_unused', checkedAt: new Date().toISOString(), nonce: record.nonce } });
    });
  }
  confirmed(id: string, receipt: SettleResponse | MppReceipt): BuyerRecord {
    return this.transaction(() => {
      this.db.prepare("UPDATE buyer_purchases SET budget_state='spent' WHERE id=? AND budget_state IN ('reserved','spent')").run(id);
      return this.update(id, { paymentState: 'confirmed', receipt });
    });
  }
}
