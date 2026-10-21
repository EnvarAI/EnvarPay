/** Owner-only, read-only inspection of original seller orders. */
import { DatabaseSync } from 'node:sqlite';
import { lstatSync } from 'node:fs';
import { CommerceError } from './types.js';
export { inspectLocalAlerts, type LocalAlertOptions } from './alerts.js';

export type InspectionView = 'attention' | 'refund-review';
const ATTENTION = "payment_state IN ('settling','unknown') OR execution_state IN ('dispatching','unknown')";
const REFUND_REVIEW = "payment_state='confirmed' AND execution_state='failed'";

export function inspectLedger(path: string, after = 0, limit = 100, view: InspectionView = 'attention') {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new CommerceError('private_file', 'Inspect an existing ledger owned only by the current user');
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new CommerceError('inspection_cursor', 'Use a nonnegative row cursor and a limit from 1 to 100');
  if (!['attention', 'refund-review'].includes(view)) throw new CommerceError('inspection_view', 'Use attention or refund-review inspection');
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000');
    if (db.prepare('SELECT version FROM commerce_meta').get()?.version !== 2) throw new CommerceError('store_version', 'Unsupported seller ledger version');
    const total = Number(db.prepare('SELECT COUNT(*) AS n FROM commerce_orders').get()!.n);
    const filter = view === 'refund-review' ? REFUND_REVIEW : ATTENTION;
    const rows = db.prepare(`SELECT rowid AS cursor,id,payment_state,execution_state,task_id FROM commerce_orders WHERE rowid>? AND (${filter}) ORDER BY rowid LIMIT ?`).all(after, limit + 1);
    const page = rows.slice(0, limit).map(row => ({
      cursor: Number(row.cursor), id: String(row.id), paymentState: String(row.payment_state),
      executionState: String(row.execution_state), taskId: typeof row.task_id === 'string' ? row.task_id : null,
      ...(view === 'refund-review' ? { reason: 'confirmed_payment_failed_execution' as const } : {}),
    }));
    const attentionCount = Number(db.prepare(`SELECT COUNT(*) AS n FROM commerce_orders WHERE ${ATTENTION}`).get()!.n);
    const refundReviewCount = Number(db.prepare(`SELECT COUNT(*) AS n FROM commerce_orders WHERE ${REFUND_REVIEW}`).get()!.n);
    return { role: 'seller' as const, view, total, attentionCount, refundReviewCount, items: page, nextCursor: page.at(-1)?.cursor ?? after, hasMore: rows.length > limit, paymentPerformed: false, refundPerformed: false };
  } finally { db.close(); }
}
