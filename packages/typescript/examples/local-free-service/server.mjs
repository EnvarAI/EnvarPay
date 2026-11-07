import { appendFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { Task } from '@a2a-js/sdk';
import { CommerceServer, CommerceStore, bearerAuthenticator, listenCommerce, nativeA2AExecutor } from '@envarai/envarpay/server';
import { HOST, SERVICE_PATH, prepareState, sellerConfig } from './shared.mjs';

/**
 * Both A2A endpoints and both SQLite stores are real SDK components.
 * The only example-specific capability is deterministic string transformation.
 * There is no Envar claim, wallet, model credential or paid offer.
 */
export async function startDemoServer(directory) {
  const state = await prepareState(directory);
  const privateOrigin = 'http://' + HOST + ':' + state.privatePort;
  const origin = 'http://' + HOST + ':' + state.publicPort;
  const cardUrl = privateOrigin + SERVICE_PATH + '/agent-card.json';
  const upstreamStore = new CommerceStore(join(state.stateDirectory, 'runtime.sqlite3'));
  let sellerStore, upstream, seller, upstreamHttp, sellerHttp;
  const controller = new AbortController();
  const closeHttp = async http => {
    if (!http) return;
    http.closeIdleConnections();
    await new Promise(resolve => http.close(resolve));
  };
  const stop = async () => {
    seller?.stop();
    upstream?.stop();
    controller.abort();
    await Promise.all([closeHttp(sellerHttp), closeHttp(upstreamHttp)]);
    while (seller?.isRunning || upstream?.isRunning) await sleep(5);
    sellerStore?.close();
    upstreamStore.close();
  };
  try {
    upstream = new CommerceServer({
      config: sellerConfig('local-private-demo', cardUrl),
      origin: privateOrigin, store: upstreamStore,
      authenticate: bearerAuthenticator({ [state.tokens.runtime]: 'local-seller' }),
      execute: async function* (order) {
        appendFileSync(join(state.stateDirectory, 'executions.jsonl'),
          JSON.stringify({ message_id: order.messageId, order_id: order.id }) + '\n',
          { mode: 0o600, flush: true });
        yield Task.fromJSON({
          id: 'deterministic-' + order.id, contextId: 'demo-' + order.id,
          status: { state: 'TASK_STATE_COMPLETED' },
          artifacts: [{ artifactId: 'uppercase-result', name: 'Deterministic demo result',
            parts: [{ text: 'DEMO ONLY: ' + order.input.text.toUpperCase() }] }],
        });
      },
    });
    upstreamHttp = listenCommerce(upstream, privateOrigin, HOST, state.privatePort);
    await once(upstreamHttp, 'listening');
    sellerStore = new CommerceStore(join(state.stateDirectory, 'seller.sqlite3'));
    seller = new CommerceServer({
      config: sellerConfig('local-free-demo', cardUrl), origin, store: sellerStore,
      authenticate: bearerAuthenticator({ [state.tokens.buyer]: 'local-buyer' }),
      execute: nativeA2AExecutor({ uppercase: state.tokens.runtime }, fetch, controller.signal),
    });
    sellerHttp = listenCommerce(seller, origin, HOST, state.publicPort);
    await once(sellerHttp, 'listening');
    return { origin, privateOrigin, stateDirectory: state.stateDirectory, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const { values } = parseArgs({ options: { 'state-dir': { type: 'string' } } });
  if (!values['state-dir']) throw new Error('Usage: node server.mjs --state-dir /private/demo-state');
  let server;
  try {
    server = await startDemoServer(values['state-dir']);
    let stopping = false;
    const shutdown = async () => {
      if (stopping) return;
      stopping = true;
      await server.stop();
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    process.stdout.write(JSON.stringify({
      event: 'ready', pid: process.pid, origin: server.origin,
      private_origin: server.privateOrigin, state_directory: server.stateDirectory,
    }) + '\n');
  } catch (error) {
    console.error('Local free example could not start: ' + error.message);
    process.exitCode = 1;
  }
}
