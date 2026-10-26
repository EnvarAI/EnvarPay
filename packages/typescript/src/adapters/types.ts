/** Runtime boundary: the Connector owns delivery; the user/vendor owns execution. */
import type { Work } from '../connector/contracts.generated.js';

export interface RuntimeReference {
  adapter: string;
  version: 1;
  /** Adapter-owned, validated original task/session handle. No credentials. */
  value: Record<string, unknown>;
}
export interface RuntimeReadiness {
  adapter: string;
  runtimeVersion: string;
  capabilities: { recover: boolean; input: boolean; cancel: boolean };
}
export interface RuntimeObservation {
  reference: RuntimeReference;
  state: 'working' | 'input_required' | 'completed' | 'failed' | 'canceled' | 'unknown';
  text?: string;
  errorCode?: string;
}
export interface RuntimeAdapter {
  readonly key: string;
  probe(): Promise<RuntimeReadiness>;
  /** Called once after durable local preparation and Envar admission. Never retries an unknown POST. */
  start(work: Work, executionKey: string): Promise<RuntimeObservation>;
  /** Observes only the original validated reference, without creating another execution. */
  observe(reference: RuntimeReference): Promise<RuntimeObservation>;
  provideInput(reference: RuntimeReference, operationId: string, text: string): Promise<RuntimeObservation>;
  cancel(reference: RuntimeReference, operationId: string): Promise<RuntimeObservation>;
  close(): Promise<void>;
}

export class RuntimeOutcomeUnknown extends Error {
  constructor(public readonly code = 'runtime_outcome_unknown') {
    super('Original runtime outcome is unknown. Preserve its execution reference; do not resubmit.');
  }
}
