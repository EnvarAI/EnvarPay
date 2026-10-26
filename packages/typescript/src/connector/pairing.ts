import { setTimeout as sleep } from 'node:timers/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { privateJson, writePrivateJson } from './files.js';

export interface PairingRequest {
  pairing_id: string; device_token: string; user_code: string; verification_uri: string; expires_at: string; interval: number;
}
export interface EnrollmentReceipt {
  version: 1; agent_id: string; connection_id: string; platform_origin: string; framework: 'hermes' | 'openclaw';
  token: string; scopes: string[]; expires_at: string;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function platformOrigin(origin: string, allowLocalHttp = false): string {
  const url = new URL(origin);
  if ((url.protocol !== 'https:' && !(allowLocalHttp && url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) ||
    url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Use the Envar HTTPS origin');
  return url.origin;
}
async function request(origin: string, path: string, body?: unknown, secret?: string, fetchImpl: typeof fetch = fetch): Promise<any> {
  const response = await fetchImpl(new URL('/api/v1/agent-enrollment/' + path, origin), {
    method: body === undefined ? 'GET' : 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json',
      ...(secret ? { Authorization: 'Bearer ' + secret } : {}) }, body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error', signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`Pairing returned HTTP ${response.status}. Check approval in Envar and retry this device.`);
  if (!response.body) throw new Error('Pairing returned an empty response');
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
  for (;;) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength;
    if (bytes > 32768) { await reader.cancel(); throw new Error('Pairing response exceeds the limit'); } chunks.push(part.value); }
  const text = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(text); } catch { throw new Error('Pairing returned invalid JSON'); }
}
export async function pairDevice(options: {
  origin: string; agentId: string; framework: 'hermes' | 'openclaw'; runtimeVersion: string; directory: string;
  onApproval: (details: Pick<PairingRequest, 'user_code' | 'verification_uri' | 'expires_at'>) => void;
  fetch?: typeof fetch; signal?: AbortSignal; poll?: () => Promise<void>; fresh?: boolean;
}): Promise<EnrollmentReceipt> {
  if (!uuid.test(options.agentId)) throw new Error('Use the Agent ID from Envar');
  const file = join(options.directory, 'pairing.json');
  let saved = existsSync(file) ? privateJson<{ origin: string; agentId: string; framework: string; pairing: PairingRequest }>(file) : undefined;
  if (saved && (saved.origin !== options.origin || saved.agentId !== options.agentId || saved.framework !== options.framework))
    throw new Error('This pairing directory belongs to another Agent or platform');
  if (options.fresh || !saved || Date.parse(saved.pairing.expires_at) <= Date.now()) {
    const pairing = await request(options.origin, 'start', { agent_id: options.agentId, framework: options.framework,
      device_name: options.framework + ' Connector', runtime_version: options.runtimeVersion.slice(0, 80) }, undefined, options.fetch) as PairingRequest;
    if (!pairing || !/^envar_pair_[A-Za-z0-9_-]{43}$/.test(pairing.device_token) || !uuid.test(pairing.pairing_id) ||
      !/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(pairing.user_code) || !Number.isFinite(Date.parse(pairing.expires_at)))
      throw new Error('Invalid pairing receipt');
    const approval = new URL(pairing.verification_uri);
    if (approval.origin !== options.origin || approval.pathname !== '/connect/device' || approval.searchParams.get('code') !== pairing.user_code ||
      approval.username || approval.password || approval.hash || [...approval.searchParams.keys()].length !== 1)
      throw new Error('Approval must remain on the selected Envar origin');
    saved = { origin: options.origin, agentId: options.agentId, framework: options.framework, pairing };
    writePrivateJson(file, saved);
  }
  const pairing = saved.pairing;
  if (!pairing || !/^envar_pair_[A-Za-z0-9_-]{43}$/.test(pairing.device_token) ||
    !Number.isFinite(Date.parse(pairing.expires_at)) || new URL(pairing.verification_uri).origin !== options.origin)
    throw new Error('Restore the original private pairing request');
  // Only the human-readable code and first-party approval URL reach stdout/callbacks.
  options.onApproval({ user_code: pairing.user_code, verification_uri: pairing.verification_uri, expires_at: pairing.expires_at });
  while (Date.now() < Date.parse(pairing.expires_at)) {
    if (options.signal?.aborted) throw new Error('Pairing stopped; the private request is preserved');
    const status = await request(options.origin, 'status', undefined, pairing.device_token, options.fetch);
    if (status.status === 'approved') {
      const receipt = await request(options.origin, 'exchange', {}, pairing.device_token, options.fetch) as EnrollmentReceipt;
      if (receipt.version !== 1 || receipt.agent_id !== options.agentId || receipt.framework !== options.framework ||
        receipt.platform_origin !== options.origin || !uuid.test(receipt.connection_id) ||
        !/^envar_agent_[A-Za-z0-9_-]{32,128}$/.test(receipt.token) || !Array.isArray(receipt.scopes) ||
        !receipt.scopes.every(scope => ['connection:read','work:read','work:receive','work:report','work:send'].includes(scope)) ||
        !['connection:read','work:read','work:receive','work:report'].every(scope => receipt.scopes.includes(scope)) ||
        !Number.isFinite(Date.parse(receipt.expires_at)))
        throw new Error('Envar returned a different connection identity or unexpected authority');
      return receipt;
    }
    if (status.status !== 'pending') throw new Error('Pairing is no longer pending. Start a new owner-approved request.');
    if (options.poll) await options.poll();
    else await sleep(2000, undefined, { signal: options.signal });
  }
  throw new Error('Pairing expired. Run connect again to request a fresh approval.');
}
