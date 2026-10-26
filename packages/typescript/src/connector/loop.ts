import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { EnvarWorkClient, WorkApiError } from './client.js';
import { ConnectorJournal, type LocalWork } from './state.js';
import type { RuntimeAdapter, RuntimeObservation } from '../adapters/types.js';
import { NativeRequestNotStarted } from '../adapters/native-a2a.js';
import { RuntimeControlUnsupported } from '../adapters/a2a-runtime.js';

const terminal = new Set(['completed', 'failed', 'canceled']);
const claimValue = (record: LocalWork) => ({ id: record.claim!.id, fence: record.claim!.fence });
export class ConnectorLoop {
  private running = false;
  private verified = false;
  constructor(readonly client: EnvarWorkClient, readonly runtime: RuntimeAdapter, readonly journal: ConnectorJournal) {}
  private async lease(record: LocalWork, recover = false): Promise<void> {
    if (!record.claim) return;
    const expires = Date.parse(record.claim.lease_until ?? '');
    const row = recover || !Number.isFinite(expires) || expires <= Date.now()
      ? await this.client.recover(record.work.id, claimValue(record), { key: record.work.id })
      : await this.client.renew(record.work.id, claimValue(record));
    record.claim = row.claim;
    if (row.status === 'unknown') record.lastObservation = undefined;
    this.journal.save(record);
  }
  private async withHeartbeat<T>(record: LocalWork, action: () => Promise<T>): Promise<T> {
    let heartbeat: Promise<void> | undefined;
    const timer = setInterval(() => {
      if (!heartbeat) heartbeat = this.lease(record).catch(() => {
        // Keep the actual native outcome. Reporting revalidates authority; never dispatch again.
        record.error = 'lease_unavailable'; this.journal.save(record);
      }).finally(() => { heartbeat = undefined; });
    }, 30000);
    try { return await action(); }
    finally { clearInterval(timer); await heartbeat; }
  }
  private async flush(record: LocalWork): Promise<void> {
    if (!record.pendingReport) return;
    let accepted;
    try {
      accepted = await this.client.report(record.work.id, record.pendingReport);
    } catch (error) {
      if (!(error instanceof WorkApiError) || error.status !== 409) throw error;
      const current = await this.client.get(record.work.id);
      if (terminal.has(current.status)) {
        record.phase = 'terminal'; record.error = 'terminal_report_conflict'; this.journal.save(record); return;
      }
      await this.lease(record, true);
      // The same exact event ID/content is retried; a lost successful response cannot duplicate an event.
      accepted = await this.client.report(record.work.id, record.pendingReport);
    }
    record.phase = terminal.has(accepted.status) ? 'terminal' : record.afterReport!; delete record.pendingReport; delete record.afterReport;
    this.journal.save(record);
  }
  private async observed(record: LocalWork, observation: RuntimeObservation): Promise<void> {
    record.reference = observation.reference; record.observation = observation; this.journal.save(record);
    if (this.journal.sameObservation(record, observation)) return;
    const state = observation.state;
    const cancelRequested = state === 'canceled' ? (await this.client.get(record.work.id)).cancel_requested_at : null;
    const kind = state === 'working' ? 'progress' : state === 'canceled' ? (cancelRequested ? 'cancel_confirmed' : 'failed')
      : state === 'unknown' ? 'outcome_unknown' : state;
    const text = observation.text || ({ working: 'Native task accepted.', input_required: 'The native Agent needs input.',
      completed: 'Native task completed.', failed: 'Native task failed.', canceled: 'Native task stopped.',
      unknown: 'Original native task outcome is unknown; no replacement was started.' })[state];
    const next = terminal.has(state) ? 'terminal' : state === 'working' ? 'running'
      : state === 'input_required' ? 'waiting_input' : 'unknown';
    this.journal.queueReport(record, kind, text, next, observation);
    await this.flush(record);
  }
  private async advance(record: LocalWork): Promise<void> {
    if (record.pendingReport) { await this.flush(record); return; }
    if (record.reference && record.observation && terminal.has(record.observation.state)) {
      await this.observed(record, record.observation); return;
    }
    if (record.phase === 'prepared') {
      try {
        const row = await this.client.claim(record.work.id, record.claimRequestId);
        if (terminal.has(row.status)) { record.phase = 'terminal'; this.journal.save(record); return; }
        record.claim = row.claim; record.phase = 'claimed'; this.journal.save(record);
      } catch (error) {
        if (!(error instanceof WorkApiError) || error.status !== 409) throw error;
        const current = await this.client.get(record.work.id);
        if (terminal.has(current.status)) { record.phase = 'terminal'; this.journal.save(record); }
        return;
      }
    }
    if (record.phase === 'claimed') {
      // A claim that expired before admission can be reacquired; never reuse its old fence to start.
      if (Date.parse(record.claim!.lease_until ?? '') <= Date.now()) {
        const current = await this.client.get(record.work.id);
        if (current.status === 'queued') {
          record.claimRequestId = randomUUID(); record.phase = 'prepared'; delete record.claim; this.journal.save(record); return;
        }
        if (terminal.has(current.status)) { record.phase = 'terminal'; this.journal.save(record); return; }
        await this.lease(record, true);
      }
      let admitted;
      try { admitted = await this.client.start(record.work.id, claimValue(record), { key: record.work.id }); }
      catch (error) {
        if (error instanceof WorkApiError && error.status === 409) {
          const current = await this.client.get(record.work.id);
          if (terminal.has(current.status)) { record.phase = 'terminal'; this.journal.save(record); return; }
        }
        throw error;
      }
      if (terminal.has(admitted.status)) { record.phase = 'terminal'; this.journal.save(record); return; }
      record.claim = admitted.claim; record.phase = 'admitted'; this.journal.save(record);
    }
    if (record.phase === 'admitted') {
      record.phase = 'dispatching'; this.journal.save(record);
      try { await this.observed(record, await this.withHeartbeat(record, () => this.runtime.start(record.work, record.work.id))); }
      catch (error) {
        if (record.pendingReport) throw error;
        // Keep any returned native handle even when its first report could not reach Envar.
        if (record.reference) { record.phase = 'running'; this.journal.save(record); throw error; }
        if (error instanceof NativeRequestNotStarted) this.journal.queueReport(record, 'failed', error.message, 'terminal');
        else this.journal.queueReport(record, 'outcome_unknown', 'Native dispatch outcome is unknown. No replacement task was started.', 'unknown');
        await this.flush(record);
      }
      return;
    }
    if (record.phase === 'dispatching' && record.reference && record.observation) {
      await this.observed(record, record.observation); return;
    }
    if (record.phase === 'dispatching') {
      // Process died between the durable dispatch marker and saving a native handle.
      this.journal.queueReport(record, 'outcome_unknown', 'Connector restarted without a confirmed native handle. Inspect the original execution; do not resubmit.', 'unknown');
      await this.flush(record); return;
    }
    if (record.reference && ['running', 'waiting_input', 'unknown'].includes(record.phase)) {
      await this.lease(record);
      try { await this.observed(record, await this.withHeartbeat(record, () => this.runtime.observe(record.reference!))); }
      catch (error) {
        if (record.pendingReport) throw error;
        if (record.phase !== 'unknown') {
          this.journal.queueReport(record, 'outcome_unknown', 'The original native Task cannot currently be observed. Its handle is retained for recovery.', 'unknown');
          await this.flush(record);
        }
      }
    }
  }
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      if (!this.verified) {
        const status = await this.client.status();
        if (status.id !== this.journal.binding.connectionId || status.agent_id !== this.journal.binding.agentId ||
            this.runtime.key !== this.journal.binding.adapter) throw new Error('Restore the original Agent/runtime binding');
        await this.runtime.probe(); this.verified = true;
      }
      let after = 0;
      for (;;) {
        const inbox = await this.client.inbox(after);
        for (const delivery of inbox.items) this.journal.ingest(delivery);
        if (!inbox.next_cursor) break;
        if (inbox.next_cursor <= after) throw new Error('Inbox cursor did not advance');
        after = inbox.next_cursor;
      }
      // Resume admitted work and reports before claiming new work. One native execution at a time.
      const active = this.journal.pending().filter(record => record.phase !== 'prepared');
      for (const record of active) await this.advance(record);
      if (!this.journal.pending().some(record => record.phase !== 'prepared')) {
        const next = this.journal.pending().find(record => record.phase === 'prepared');
        if (next) await this.advance(next);
      }
      for (const delivery of this.journal.deliveries()) {
        const record = this.journal.get(delivery.work.id);
        if (delivery.kind === 'work' && record?.phase !== 'terminal') continue;
        if (['input', 'cancel'].includes(delivery.kind) && record?.phase !== 'terminal') {
          if (!record?.reference || record.pendingReport) continue;
          const control = this.journal.control(delivery.id);
          if (control.phase === 'prepared') {
            control.phase = 'dispatching'; this.journal.saveControl(control);
            try {
              control.observation = delivery.kind === 'cancel'
                ? await this.runtime.cancel(record.reference, control.operationId)
                : await this.runtime.provideInput(record.reference, control.operationId, String(delivery.event.text ?? ''));
              control.phase = 'observed';
            } catch (error) {
              control.phase = error instanceof RuntimeControlUnsupported ? 'unsupported' : 'unknown';
              control.text = error instanceof RuntimeControlUnsupported ? error.message
                : 'Native control outcome is unknown. Preserve the original task; do not repeat the control.';
            }
            this.journal.saveControl(control);
          }
          if (control.phase === 'dispatching') {
            control.phase = 'unknown'; control.text = 'Connector restarted during a native control. Its outcome is unknown; it was not repeated.';
            this.journal.saveControl(control);
          }
          if (control.phase === 'observed') await this.observed(record, control.observation!);
          if (control.phase === 'unknown' || control.phase === 'unsupported') {
            this.journal.queueReport(record, control.phase === 'unknown' ? 'outcome_unknown' : 'progress',
              control.text!, control.phase === 'unknown' ? 'unknown' : 'running', undefined, control.operationId);
            await this.flush(record);
          }
          control.phase = 'reported'; this.journal.saveControl(control);
        }
        // Results are saved locally before ack; outgoing MCP tools can read the durable original result.
        await this.client.acknowledge(delivery.id); this.journal.acknowledge(delivery.id);
      }
    } finally { this.running = false; }
  }
  async run(signal: AbortSignal, onError: (error: unknown) => void = () => {}): Promise<void> {
    while (!signal.aborted) {
      let delay = 5000;
      try { await this.tick(); }
      catch (error) {
        onError(error);
        if (error instanceof WorkApiError && [401, 403].includes(error.status)) throw error;
        delay = error instanceof WorkApiError && error.retryAfter ? error.retryAfter * 1000 : 15000;
      }
      try { await sleep(delay, undefined, { signal }); } catch { if (!signal.aborted) throw new Error('Connector wait interrupted'); }
    }
  }
}
