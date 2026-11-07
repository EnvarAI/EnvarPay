import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { join, resolve } from 'node:path';

export const MESSAGE_ID = 'local-free-service-original-v1';
export const INPUT = Object.freeze({ text: 'Hello from the local free service' });
export const EXPECTED_TEXT = 'DEMO ONLY: HELLO FROM THE LOCAL FREE SERVICE';
export const SERVICE_PATH = '/services/uppercase/v1/offers/free';
export const HOST = '127.0.0.1';

export function privateFile(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077)) {
    throw new Error('Use an owner-only regular demo state file: ' + path);
  }
  return readFileSync(path, 'utf8');
}
export function readJson(path) { return JSON.parse(privateFile(path)); }

async function reservePorts() {
  const servers = [createServer(), createServer()];
  try {
    for (const server of servers) {
      server.listen(0, HOST);
      await once(server, 'listening');
    }
    return servers.map(server => server.address().port);
  } finally {
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
  }
}

/** Example state is private and deliberately kept after the demonstration. */
export async function prepareState(directory) {
  const stateDirectory = resolve(directory);
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(stateDirectory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) {
    throw new Error('Choose a private demo directory (mode 700), not a symlink.');
  }
  const metadataPath = join(stateDirectory, 'demo.json');
  if (!existsSync(metadataPath)) {
    if (readdirSync(stateDirectory).length) throw new Error('Choose an empty directory or this example’s original state directory.');
    const [privatePort, publicPort] = await reservePorts();
    writeFileSync(join(stateDirectory, 'tokens.json'), JSON.stringify({
      buyer: randomBytes(32).toString('hex'),
      runtime: randomBytes(32).toString('hex'),
    }), { mode: 0o600, flag: 'wx', flush: true });
    writeFileSync(metadataPath, JSON.stringify({
      example: 'envarpay-local-free-service', version: 1, privatePort, publicPort,
    }), { mode: 0o600, flag: 'wx', flush: true });
  }
  const metadata = readJson(metadataPath);
  const tokens = readJson(join(stateDirectory, 'tokens.json'));
  if (metadata.example !== 'envarpay-local-free-service' || metadata.version !== 1 ||
      ![metadata.privatePort, metadata.publicPort].every(p => Number.isInteger(p) && p > 0 && p < 65536) ||
      metadata.privatePort === metadata.publicPort ||
      ![tokens.buyer, tokens.runtime].every(t => typeof t === 'string' && /^[a-f0-9]{64}$/.test(t))) {
    throw new Error('Preserve the original demo state; its identity or local credentials are invalid.');
  }
  return { stateDirectory, ...metadata, tokens };
}

export function sellerConfig(agentId, cardUrl) {
  return {
    configVersion: 1,
    agent: { id: agentId, name: 'Local deterministic demonstration — no model' },
    paymentProfiles: {},
    services: [{
      id: 'uppercase', name: 'Deterministic uppercase demo', revision: 1,
      execution: { type: 'a2a', cardUrl },
      contract: {
        inputSchema: {
          type: 'object', additionalProperties: false,
          properties: { text: { type: 'string', minLength: 1, maxLength: 500 } },
          required: ['text'],
        },
        deliverables: ['Uppercase text prefixed with DEMO ONLY'],
        targetDurationSeconds: 30, includedRevisions: 0,
      },
      offers: [{ id: 'free', pricing: { kind: 'free' }, collection: { kind: 'none' } }],
    }],
  };
}
