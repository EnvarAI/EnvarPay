import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pairDevice, platformOrigin } from './pairing.js';
import { inspectNative, configureNative } from '../adapters/configure-native.js';
import { connectorClient, connectorDirectory, connectorJournal, readConnector, runtimeAdapter, type ConnectorConfig } from './config.js';
import { privateDirectory, privateJson, writePrivate, writePrivateJson } from './files.js';
import { ConnectorLoop } from './loop.js';
import { connectorMcp } from './mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const usage = `Envar Connector\nenvarpay connector connect --agent UUID --framework hermes|openclaw [--home PROFILE] [--native-agent main]\nenvarpay connector run --agent UUID\nenvarpay connector doctor --agent UUID\nenvarpay connector status --agent UUID\nenvarpay connector disconnect --agent UUID\nAdvanced: use --directory PATH for an existing private state directory. Keep its journal to recover original tasks.`;
const output = (value: unknown) => console.log(JSON.stringify(value, null, 2));
export async function runConnectorCli(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    agent: { type: 'string' }, framework: { type: 'string' }, home: { type: 'string' }, directory: { type: 'string' },
    origin: { type: 'string' }, 'native-agent': { type: 'string' }, 'runtime-url': { type: 'string' }, connection: { type: 'string' },
    'allow-local-http': { type: 'boolean' }, 'new-pairing': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } });
  const command = positionals[0];
  if (values.help || !command) { console.log(usage); return; }
  if (!['connect', 'run', 'doctor', 'status', 'disconnect', 'mcp'].includes(command)) throw new Error(usage);
  const directory = connectorDirectory(values.agent, values.directory);
  if (command === 'connect') {
    if (!values.agent || !['hermes', 'openclaw'].includes(values.framework ?? '')) throw new Error('Choose the Agent ID and its Hermes/OpenClaw platform');
    const framework = values.framework as 'hermes' | 'openclaw';
    const origin = platformOrigin(values.origin ?? 'https://envar.ai', values['allow-local-http']);
    privateDirectory(directory);
    const native = inspectNative(framework, { home: values.home, nativeAgent: values['native-agent'], cardUrl: values['runtime-url'] });
    const file = join(directory, 'connector.json');
    let config = existsSync(file) ? privateJson<ConnectorConfig>(file) : undefined;
    if (config && (config.agentId !== values.agent || config.framework !== framework || config.origin !== origin ||
      config.runtime.home !== native.home || config.runtime.agentId !== native.agentId || config.runtime.cardUrl !== native.cardUrl))
      throw new Error('This Connector directory already belongs to another Agent/runtime. Preserve it and select another directory.');
    if (!config || config.disabled || values['new-pairing']) {
      const receipt = await pairDevice({ origin, agentId: values.agent, framework, runtimeVersion: native.runtimeVersion, directory,
        fresh: Boolean(config?.disabled || values['new-pairing']),
        onApproval: details => output({ action: 'approve_in_browser', ...details,
          next: 'Open the Envar link, match this short code and Agent name, then approve the device.' }),
      });
      writePrivate(join(directory, `credential-${receipt.connection_id}.txt`), receipt.token + '\n');
      config = { version: 1, origin, agentId: receipt.agent_id, connectionId: receipt.connection_id, framework,
        scopes: receipt.scopes, expiresAt: receipt.expires_at, allowLocalHttp: values['allow-local-http'] ?? false,
        nativeConfigured: false, runtime: { home: native.home, configFile: native.configFile, port: native.port, agentId: native.agentId, cardUrl: native.cardUrl,
          binary: native.binary, peerName: 'envar-' + receipt.agent_id, mcpName: 'envar-' + receipt.agent_id } };
      writePrivateJson(file, config);
    }
    const status = await connectorClient(directory, config).status();
    const restartRequired = configureNative(directory, config); config.nativeConfigured = true; writePrivateJson(file, config);
    output({ status: 'configured', agent_id: config.agentId, directory,
      restart_required: restartRequired, receiver_online: status.readiness.online === true,
      next: restartRequired ? 'Restart the existing native gateway using its normal deployment method when ready. Then keep the Connector running.' : 'Configuration is unchanged. Keep the Connector running and test it from the Agent page.',
      native_profile_env: framework === 'hermes' ? { HERMES_HOME: config.runtime.home } : { OPENCLAW_STATE_DIR: config.runtime.home, OPENCLAW_CONFIG_PATH: config.runtime.configFile },
      service_restart: [...config.runtime.binary, 'gateway', 'restart'],
      foreground_gateway: [...config.runtime.binary, 'gateway', 'run'],
      docker_restart: 'Restart the Agent container from its Docker host; do not run a second gateway.',
      run: ['envarpay', 'connector', 'run', '--directory', directory],
      test: config.origin + '/console/agents/' + config.agentId,
      verified: status.readiness.roundtrip_verified === true && !restartRequired, expires_at: config.expiresAt });
    return;
  }
  const config = readConnector(directory);
  if (values.connection && values.connection !== config.connectionId) throw new Error('This native MCP process belongs to an earlier connection. Reload its configuration.');
  const client = connectorClient(directory, config);
  if (command === 'disconnect') {
    const receipt = await client.disconnect();
    if (!receipt.credential_revoked) throw new Error('Envar did not confirm revocation');
    config.disabled = true; writePrivateJson(join(directory, 'connector.json'), config);
    output({ status: 'disconnected', ...receipt, journal_preserved: true,
      next: 'Stop this Connector process. Already admitted native tasks keep their original outcome; inspect them in Envar.' });
    return;
  }
  if (command === 'status') { output(await client.status()); return; }
  if (command === 'doctor') {
    const connection = await client.status(), runtime = await runtimeAdapter(directory, config).probe();
    output({ connection_id: connection.id, agent_id: connection.agent_id, runtime,
      readiness: connection.readiness, next: 'Send the free test from the Envar Agent page and inspect its returned result.' });
    return;
  }
  if (!config.nativeConfigured) throw new Error('Finish connector connect before starting it');
  const journal = connectorJournal(directory, config);
  if (command === 'mcp') {
    const server = connectorMcp(client, journal, config.scopes);
    const close = async () => { await server.close(); journal.close(); };
    process.once('SIGTERM', () => { void close().finally(() => process.exit(0)); });
    process.once('SIGINT', () => { void close().finally(() => process.exit(0)); });
    await server.connect(new StdioServerTransport());
    return;
  }
  journal.acquireProcessLock(join(directory, 'receiver.lock'));
  const runtime = runtimeAdapter(directory, config), controller = new AbortController();
  process.once('SIGTERM', () => controller.abort()); process.once('SIGINT', () => controller.abort());
  output({ status: 'starting', agent_id: config.agentId, connection_id: config.connectionId,
    next: 'Keep this process and the native gateway running. Status in Envar updates after contact and a real test.' });
  try { await new ConnectorLoop(client, runtime, journal).run(controller.signal, error => {
    console.error(error instanceof Error ? error.message : 'Connector request failed; original work is preserved');
  }); }
  finally { await runtime.close(); journal.close(); }
}
