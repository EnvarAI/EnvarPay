// Legacy command uses the same implementation and advertises the installed entrypoint.
import { runConnectorCli as runConnect } from '@envarai/connect/connector/cli';
export const runConnectorCli = (args: string[]) => runConnect(args, ['envarpay', 'connector']);
