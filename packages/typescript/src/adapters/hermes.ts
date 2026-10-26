import { A2ARuntimeAdapter } from './a2a-runtime.js';
import type { NativeA2ASettings } from './native-a2a.js';

/** Hermes' native A2A platform injects work into its real gateway session. */
export class HermesRuntimeAdapter extends A2ARuntimeAdapter {
  constructor(settings: NativeA2ASettings) { super('hermes', settings); }
}
