#!/usr/bin/env node
if (process.argv[2] === 'connector') {
  try { await (await import('./connector/cli.js')).runConnectorCli(process.argv.slice(3)); }
  catch (error) { console.error(error instanceof Error ? error.message : 'Connector operation failed'); process.exitCode = 1; }
} else {
  await import('./commerce/cli.js');
}
