import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { privateJson, privateText } from './files.js';
import { platformOrigin } from './pairing.js';
import { EnvarWorkClient } from './client.js';
import { ConnectorJournal } from './state.js';
import { HermesRuntimeAdapter } from '../adapters/hermes.js';
import { OpenClawRuntimeAdapter } from '../adapters/openclaw.js';

export interface ConnectorConfig {
  version: 1; origin: string; agentId: string; connectionId: string; framework: 'hermes' | 'openclaw';
  scopes: string[]; expiresAt: string; allowLocalHttp?: boolean; nativeConfigured: boolean; disabled?: boolean;
  runtime: { home: string; configFile?: string; port?: number; agentId: string; cardUrl: string; binary: string[]; peerName: string; mcpName: string };
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function connectorDirectory(agentId?: string, directory?: string): string {
  if (directory) return resolve(directory);
  if (!agentId || !uuid.test(agentId)) throw new Error('Provide --agent UUID or the original --directory');
  return join(homedir(), '.envarpay', 'connectors', agentId);
}
export function readConnector(directory: string): ConnectorConfig {
  const config = privateJson<ConnectorConfig>(join(directory, 'connector.json'));
  if (config.version !== 1 || !uuid.test(config.agentId) || !uuid.test(config.connectionId) ||
    !['hermes','openclaw'].includes(config.framework) || !Array.isArray(config.scopes) || !config.runtime?.cardUrl ||
    config.runtime.peerName !== 'envar-' + config.agentId || config.runtime.mcpName !== 'envar-' + config.agentId)
    throw new Error('Invalid Connector configuration');
  platformOrigin(config.origin, config.allowLocalHttp);
  if (config.disabled) throw new Error('This Connector is disconnected; approve a fresh connection in Envar');
  return config;
}
export function connectorClient(directory: string, config = readConnector(directory)) {
  return new EnvarWorkClient(config.origin, privateText(join(directory, `credential-${config.connectionId}.txt`)).trim(),
    { allowLocalHttp: config.allowLocalHttp });
}
export function connectorJournal(directory: string, config = readConnector(directory)) {
  return new ConnectorJournal(join(directory, `journal-${config.connectionId}.sqlite3`), { origin: config.origin,
    agentId: config.agentId, connectionId: config.connectionId, adapter: config.framework, cardUrl: config.runtime.cardUrl });
}
export function runtimeAdapter(directory: string, config = readConnector(directory)) {
  const settings = { cardUrl: config.runtime.cardUrl, token: privateText(join(directory, 'native.token')).trim() };
  return config.framework === 'hermes' ? new HermesRuntimeAdapter(settings) : new OpenClawRuntimeAdapter(settings);
}
