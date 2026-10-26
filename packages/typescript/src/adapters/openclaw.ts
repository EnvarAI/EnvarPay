import { A2ARuntimeAdapter } from './a2a-runtime.js';
import type { NativeA2ASettings } from './native-a2a.js';

/** OpenClaw's bundled A2A channel preserves peer/context isolation and native tool policy. */
export class OpenClawRuntimeAdapter extends A2ARuntimeAdapter {
  constructor(settings: NativeA2ASettings) { super('openclaw', settings); }
}
