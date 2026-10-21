/** Read-only health signals for one seller ledger and its Envar report queue. */
import { DatabaseSync } from 'node:sqlite';
import { lstatSync } from 'node:fs';

type Name = 'ledger_read' | 'payment_unknown' | 'execution_unknown' | 'report_backlog' | 'report_failure';
type Signal = { name: Name; status: 'clear' | 'alert' | 'unavailable' | 'not_applicable'; severity: 'info' | 'warning' | 'critical'; count: number | null };
export interface LocalAlertOptions { integrationPath?: string; integrationDisabled?: boolean; }

function database(path: string): DatabaseSync {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error('private_source_unavailable');
  const db = new DatabaseSync(path, { readOnly: true });
  try { db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000; BEGIN'); return db; }
  catch (error) { db.close(); throw error; }
}
const count = (db: DatabaseSync, sql: string): number => Number(db.prepare(sql).get()!.n);
const signal = (name: Name, value: number, severity: 'warning' | 'critical' = 'warning'): Signal => ({ name, status: value ? 'alert' : 'clear', severity: value ? severity : 'info', count: value });
const missing = (name: Name): Signal => ({ name, status: 'unavailable', severity: 'warning', count: null });
const irrelevant = (name: Name): Signal => ({ name, status: 'not_applicable', severity: 'info', count: null });

export function inspectLocalAlerts(path: string, options: LocalAlertOptions = {}) {
  const signals: Signal[] = [];
  let db: DatabaseSync | undefined;
  let available = false;
  try {
    db = database(path);
    if (db.prepare("SELECT version FROM commerce_meta").get()?.version !== 2) throw new Error('unknown_version');
    signals.push(
      signal('ledger_read', 0),
      signal('payment_unknown', count(db, "SELECT COUNT(*) n FROM commerce_orders WHERE payment_state='unknown'"), 'critical'),
      signal('execution_unknown', count(db, "SELECT COUNT(*) n FROM commerce_orders WHERE execution_state='unknown'")),
    );
    available = true;
  } catch {
    signals.push(missing('ledger_read'), missing('payment_unknown'), missing('execution_unknown'));
  } finally { db?.close(); }

  let integration: DatabaseSync | undefined;
  try {
    if (options.integrationDisabled && !options.integrationPath) {
      signals.push(irrelevant('report_backlog'), irrelevant('report_failure'));
    } else {
      if (options.integrationDisabled || !options.integrationPath) throw new Error('integration_not_supplied');
      integration = database(options.integrationPath);
      if (!integration.prepare("SELECT value FROM meta WHERE key='binding'").get() || !integration.prepare("SELECT value FROM meta WHERE key='source_instance'").get()) throw new Error('integration_schema');
      signals.push(
        signal('report_backlog', count(integration, "SELECT COUNT(*) n FROM outbox WHERE state='pending'")),
        signal('report_failure', count(integration, "SELECT COUNT(*) n FROM outbox WHERE state='pending' AND attempts>0 AND last_error<>''")),
      );
    }
  } catch { signals.push(missing('report_backlog'), missing('report_failure')); }
  finally { integration?.close(); }

  const alertCount = signals.filter(s => s.status === 'alert').length;
  const unavailableCount = signals.filter(s => s.status === 'unavailable').length;
  return {
    role: available ? 'seller' as const : 'unavailable' as const,
    view: 'alerts' as const,
    observation: 'local_persisted_state_only' as const,
    status: !available ? 'unavailable' as const : unavailableCount ? 'partial' as const : 'available' as const,
    signals, budgets: [], alertCount, unavailableCount,
    providerHealth: 'unavailable_not_probed' as const,
    recommendedExitCode: unavailableCount ? 3 : alertCount ? 2 : 0,
    paymentPerformed: false, refundPerformed: false, networkRequests: 0,
  };
}
