import { DatabaseSync } from 'node:sqlite';
import { lstatSync, readFileSync } from 'node:fs';
import { loadBuyerPolicy } from './config.js';

const CURRENCIES = {
  usd: 'usd_cents',
  'eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 'base_usdc_atomic',
  'eip155:84532/erc20:0x036cbd53842c5426634e7929541ec2318f3dcf7e': 'base_sepolia_usdc_atomic',
} as const;
type SignalName = 'ledger_read' | 'payment_unknown' | 'execution_unknown' | 'recorded_provider_failure' | 'budget_near_limit' | 'budget_exhausted' | 'report_backlog' | 'report_failure';
type Signal = { name: SignalName; status: 'clear' | 'alert' | 'unavailable' | 'not_applicable'; severity: 'info' | 'warning' | 'critical'; count: number | null };
type Budget = { unit: string; maxTotal: string; reserved: string; spent: string; remaining: string; state: 'available' | 'near_limit' | 'exhausted' };
type Row = Record<string, unknown>;
export interface LocalAlertOptions { policyPath?: string; integrationPath?: string; integrationDisabled?: boolean; }

function privateFile(path: string, limit?: number): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid()) || (limit !== undefined && stat.size > limit)) throw new Error('private_source_unavailable');
}
function database(path: string): DatabaseSync {
  privateFile(path);
  const db = new DatabaseSync(path, { readOnly: true });
  try { db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000; BEGIN'); return db; }
  catch (error) { db.close(); throw error; }
}
const count = (db: DatabaseSync, sql: string): number => Number(db.prepare(sql).get()!.n);
const signal = (name: SignalName, value: number, severity: 'warning' | 'critical' = 'warning'): Signal => ({ name, status: value ? 'alert' : 'clear', severity: value ? severity : 'info', count: value });
const missing = (name: SignalName): Signal => ({ name, status: 'unavailable', severity: 'warning', count: null });
const irrelevant = (name: SignalName): Signal => ({ name, status: 'not_applicable', severity: 'info', count: null });

/** Owner-local aggregate evidence only. Never opens a runtime store, signer, vault or network. */
export function inspectLocalAlerts(path: string, options: LocalAlertOptions = {}) {
  const signals: Signal[] = [], budgets: Budget[] = [];
  let role: 'buyer' | 'seller' | 'unavailable' = 'unavailable', db: DatabaseSync | undefined;
  try {
    db = database(path);
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
    if (tables.has('buyer_purchases') === tables.has('commerce_orders')) throw new Error('unknown_ledger');
    role = tables.has('buyer_purchases') ? 'buyer' : 'seller';
    if (db.prepare(`SELECT version FROM ${role === 'buyer' ? 'buyer_meta' : 'commerce_meta'}`).get()?.version !== (role === 'buyer' ? 1 : 2)) throw new Error('unknown_version');
    const unknownPayments = count(db, role === 'buyer' ? "SELECT COUNT(*) n FROM buyer_purchases WHERE json_extract(record_json,'$.paymentState')='unknown'" : "SELECT COUNT(*) n FROM commerce_orders WHERE payment_state='unknown'");
    const unknownExecution = count(db, role === 'buyer' ? "SELECT COUNT(*) n FROM buyer_purchases WHERE json_extract(record_json,'$.executionState')='unknown'" : "SELECT COUNT(*) n FROM commerce_orders WHERE execution_state='unknown'");
    // Only concrete persisted provider errors count. Generic unknown is not proof of provider failure.
    const providerFailures = count(db, role === 'buyer'
      ? "SELECT COUNT(*) n FROM buyer_purchases WHERE json_extract(record_json,'$.paymentState')!='confirmed' AND json_extract(record_json,'$.errorCode') IN ('stripe_transport_unknown','stripe_request_failed','stripe_rate_limit','stripe_response','stripe_response_size')"
      : "SELECT COUNT(*) n FROM commerce_payment_attempts WHERE state!='confirmed' AND json_extract(receipt_json,'$.success')=0 AND length(json_extract(receipt_json,'$.errorReason'))>0");
    signals.push(signal('ledger_read', 0), signal('payment_unknown', unknownPayments), signal('execution_unknown', unknownExecution), signal('recorded_provider_failure', providerFailures));
    if (role === 'seller') signals.push(irrelevant('budget_near_limit'), irrelevant('budget_exhausted'));
    else {
      try {
        if (!options.policyPath) throw new Error('policy_required');
        privateFile(options.policyPath, 1024 * 1024);
        const policy = loadBuyerPolicy(JSON.parse(readFileSync(options.policyPath, 'utf8')));
        const usage = new Map<string, { reserved: bigint; spent: bigint }>();
        for (const b of policy.budgets) usage.set(b.currency, { reserved: 0n, spent: 0n });
        for (const row of db.prepare("SELECT currency,amount,budget_state FROM buyer_purchases WHERE budget_state!='none'").iterate() as Iterable<Row>) {
          const currency = String(row.currency), amount = String(row.amount), state = row.budget_state;
          const target = usage.get(currency);
          if (!target || !/^[1-9][0-9]{0,77}$/.test(amount) || !['spent', 'reserved'].includes(String(state))) throw new Error('budget_binding');
          target[state === 'spent' ? 'spent' : 'reserved'] += BigInt(amount);
        }
        const checked = policy.budgets.map(b => {
          const u = usage.get(b.currency)!, cap = BigInt(b.maxTotal), used = u.reserved + u.spent;
          const state: Budget['state'] = used >= cap ? 'exhausted' : used * 10n >= cap * 9n ? 'near_limit' : 'available';
          return { unit: CURRENCIES[b.currency as keyof typeof CURRENCIES], maxTotal: cap.toString(), reserved: u.reserved.toString(), spent: u.spent.toString(), remaining: (used < cap ? cap - used : 0n).toString(), state };
        });
        budgets.push(...checked);
        signals.push(signal('budget_near_limit', checked.filter(b => b.state === 'near_limit').length), signal('budget_exhausted', checked.filter(b => b.state === 'exhausted').length, 'critical'));
      } catch { signals.push(missing('budget_near_limit'), missing('budget_exhausted')); }
    }
  } catch {
    role = 'unavailable'; signals.length = 0; budgets.length = 0;
    signals.push(...(['ledger_read', 'payment_unknown', 'execution_unknown', 'recorded_provider_failure', 'budget_near_limit', 'budget_exhausted'] as const).map(missing));
  } finally { db?.close(); }

  let integration: DatabaseSync | undefined;
  try {
    if (options.integrationDisabled && !options.integrationPath) {
      signals.push(irrelevant('report_backlog'), irrelevant('report_failure'));
    } else {
    if (options.integrationDisabled) throw new Error('ambiguous_integration');
    if (!options.integrationPath) throw new Error('integration_not_supplied');
    integration = database(options.integrationPath);
    const binding = integration.prepare("SELECT value FROM meta WHERE key='binding'").get();
    const source = integration.prepare("SELECT value FROM meta WHERE key='source_instance'").get();
    if (!binding || !source || typeof binding.value !== 'string' || typeof source.value !== 'string') throw new Error('integration_schema');
    const parsed = JSON.parse(binding.value);
    if (!parsed || typeof parsed.platformOrigin !== 'string' || typeof parsed.agentId !== 'string' || typeof parsed.runtimeAgentId !== 'string') throw new Error('integration_schema');
    const pending = count(integration, "SELECT COUNT(*) n FROM outbox WHERE state='pending'");
    const failed = count(integration, "SELECT COUNT(*) n FROM outbox WHERE state='pending' AND attempts>0 AND last_error<>''");
    signals.push(signal('report_backlog', pending), signal('report_failure', failed));
    }
  } catch { signals.push(missing('report_backlog'), missing('report_failure')); }
  finally { integration?.close(); }
  const alertCount = signals.filter(s => s.status === 'alert').length, unavailableCount = signals.filter(s => s.status === 'unavailable').length;
  return {
    role, view: 'alerts' as const, observation: 'local_persisted_state_only' as const,
    status: role === 'unavailable' ? 'unavailable' : unavailableCount ? 'partial' : 'available',
    signals, budgets, alertCount, unavailableCount,
    providerHealth: 'unavailable_not_probed' as const,
    recommendedExitCode: unavailableCount ? 3 : alertCount ? 2 : 0,
    paymentPerformed: false, refundPerformed: false, networkRequests: 0,
  };
}
