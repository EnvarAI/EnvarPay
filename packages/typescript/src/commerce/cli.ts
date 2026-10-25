#!/usr/bin/env node
import { readFileSync, lstatSync, mkdirSync, writeFileSync,readdirSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { dirname, join, resolve } from 'node:path';
import { AgentCard } from '@a2a-js/sdk';
import { loadCommerceConfig, digest } from './config.js';
import { createOfferCard } from './card.js';
import { CommerceStore } from './store.js';
import { CommerceServer, bearerAuthenticator } from './server.js';
import { EnvarIntegration, type EnvarPolicy } from './envar.js';
import { EnvarSellerRuntime, PinnedUpstreams, restoreEnvarConfig } from './envar-runtime.js';
import { listenCommerce } from './http.js';
import { CredentialVault } from './vault.js';
import { EnvarBalanceGate } from './envar-balance.js';
import { CommerceError } from './types.js';
import { createNativeSkillExecutor, type NativeSkillSettings } from './native-skills.js';
import { inspectLedger, inspectLocalAlerts } from './operations.js';
import { serveManaged } from './managed.js';
import { setupAgent } from './setup.js';
import { SkillDiscovery } from './discovery.js';
import {upgradeDiscovery} from './configure.js';
import {agentSetup} from './agent-setup.js';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  config: { type: 'string' }, service: { type: 'string' }, offer: { type: 'string' }, origin: { type: 'string' },
  version: { type: 'boolean' }, help: {type:'boolean',short:'h'}, state: { type: 'string' }, credentials: { type: 'string' }, host: { type: 'string' },
  port: { type: 'string' }, directory: { type: 'string' }, 'envar-config': {type:'string'}, 'envar-credentials': {type:'string'},
  after:{type:'string'}, limit:{type:'string'}, 'refund-review':{type:'boolean'}, alerts:{type:'boolean'}, 'fail-on-alert':{type:'boolean'}, 'integration-state':{type:'string'}, 'no-integration':{type:'boolean'},
  framework:{type:'string'},file:{type:'string'},'docker-container':{type:'string'},python:{type:'string'},'hermes-home':{type:'string'},check:{type:'boolean'},
} });
const usage = 'envarpay setup --file envar-setup.json [--docker-container NAME | --python PATH] [--hermes-home PATH] [--directory DIR]\nenvarpay onboard --file invitation.json [--framework hermes|openclaw] [--check] [--python PATH] [--docker-container NAME] [--hermes-home PATH] [--origin HTTPS_ORIGIN]\nenvarpay upgrade --directory DIR [--hermes-home PATH]\nenvarpay external-setup --directory DIR --origin HTTPS_ORIGIN | external-serve --config FILE --credentials FILE --state DB --origin HTTPS_ORIGIN\nenvarpay init --directory DIR | inspect --state DB [--after ROW --limit 100 --refund-review] | validate --config seller.json | card --config seller.json --service ID --offer ID --origin URL | serve --config FILE --credentials FILE --state DB --origin URL';
const closers: (() => void | Promise<void>)[] = [];
function privateFile(path: string): Buffer {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.size > 1024 * 1024) throw new CommerceError('private_file', 'Credentials must be bounded owner-only files (chmod 600)');
  return readFileSync(path);
}
function port(defaultPort: number): number {
  const result = Number(values.port ?? defaultPort);
  if (!Number.isInteger(result) || result < 1 || result > 65535) throw new CommerceError('listen_port', 'Invalid listen port');
  return result;
}
function signals(): void {
  let stopping = false;
  const stop = async () => {
    if (stopping) return; stopping = true;
    const deadline = setTimeout(() => process.exit(1), 60000); deadline.unref();
    let failed=false;for (const close of closers.reverse()) {try{await close()}catch{failed=true}}
    clearTimeout(deadline); process.exit(failed?1:0);
  };
  process.once('SIGTERM', () => void stop()); process.once('SIGINT', () => void stop());
}
async function closeHttp(http: import('node:http').Server): Promise<void> {
  await new Promise<void>((resolve,reject)=>http.close(error=>error?reject(error):resolve()));
}
async function run(): Promise<void> {
  if(values.help||positionals.length===0&&!values.version){console.log(usage);return;}
  if (values.version) { console.log(createRequire(import.meta.url)('../../package.json').version); return; }
  const command = positionals[0];
  if(command==='external-setup'){const {setupExternalAgent}=await import('./external-runtime.js');if(!values.directory||!values.origin)throw new CommerceError('external_setup','Provide directory and public HTTPS origin');console.log(JSON.stringify(setupExternalAgent(values.directory,values.origin)));return;}
  if(command==='external-serve'){const {serveExternalAgent}=await import('./external-runtime.js');if(!values.config||!values.credentials||!values.state||!values.origin)throw new CommerceError('external_serve','Provide config, credentials, state and origin');const runtime=serveExternalAgent({configFile:values.config,credentialsFile:values.credentials,stateFile:values.state,origin:values.origin,host:values.host??'127.0.0.1',port:port(4020)});closers.push(()=>runtime.close());await once(runtime.http,'listening');signals();console.log(JSON.stringify({listening:port(4020),role:'external-agent',paymentsEnabled:false}));return;}
  if(values.framework && !['hermes','openclaw'].includes(values.framework))throw new CommerceError('setup_runtime','Use hermes or openclaw');
  if(command==='managed-serve'){
    if(!values.directory||!values.origin)throw new CommerceError('managed_configuration','Managed serve requires its directory and HTTPS origin');
    await serveManaged(values.directory,values.origin,values.host??'127.0.0.1',port(4020));return;
  }
  if(command==='onboard'){
    if(!values.file)throw new CommerceError('setup_file','Save the private invitation and pass --file PATH.');
    await agentSetup({framework:values.framework as 'hermes'|'openclaw'|undefined,file:values.file,directory:values.directory,python:values.python,home:values['hermes-home'],container:values['docker-container'],origin:values.origin,port:values.port?port(4020):undefined,checkOnly:values.check});return;
  }
  if(command==='upgrade'&&values.directory){upgradeDiscovery(values.directory,values['hermes-home']);return;}
  if(command==='setup'){
    if(!values.file)throw new CommerceError('setup_file','Download the setup file from your Agent service page and pass --file PATH');
    await setupAgent({framework:values.framework as 'hermes'|'openclaw'|undefined,file:values.file,directory:values.directory,container:values['docker-container'],python:values.python,home:values['hermes-home']});return;
  }
  if(values.alerts||values['fail-on-alert']||values['integration-state']||values['no-integration']) {
    if(command!=='inspect'||!values.state||!values.alerts||values['refund-review']||values.after||values.limit||(values['no-integration']&&values['integration-state']))throw new CommerceError('inspection_view','Alert inspection needs inspect --state and --alerts, without pagination or refund review; choose at most one integration source');
    const report=inspectLocalAlerts(values.state,{integrationPath:values['integration-state'],integrationDisabled:values['no-integration']});
    console.log(JSON.stringify(report,null,2));if(values['fail-on-alert'])process.exitCode=report.recommendedExitCode;return;
  }
  if(command==='inspect'&&values.state){console.log(JSON.stringify(inspectLedger(values.state,Number(values.after??0),Number(values.limit??100),values['refund-review']?'refund-review':'attention'),null,2));return;}
  if(values['refund-review'])throw new CommerceError('inspection_view','Refund review is available only for inspect');
  if((values['envar-config']||values['envar-credentials'])&&command!=='serve')throw new CommerceError('envar_role','Configuration synchronization is available on seller serve only');
  if(Boolean(values['envar-config'])!==Boolean(values['envar-credentials']))throw new CommerceError('envar_configuration','Supply both --envar-config and --envar-credentials');
  if (command === 'init' && values.directory) {
    mkdirSync(values.directory, { recursive: true, mode: 0o700 });
    for (const [name, source] of [['seller.json', 'seller.json']]) {
      writeFileSync(join(values.directory, name!), readFileSync(new URL(`../../examples/${source}`, import.meta.url)), { flag: 'wx', mode: 0o600 });
    }
    writeFileSync(join(values.directory, 'vault.key'), randomBytes(32), { flag: 'wx', mode: 0o600, flush: true });
    console.log(JSON.stringify({ directory: values.directory, configured: false, paymentPerformed: false, next: 'Review placeholder addresses, prices, runtime and private credential files before serve' })); return;
  }
  if (!values.config) throw new CommerceError('usage', usage);
  const raw = JSON.parse(readFileSync(values.config, 'utf8'));
  let config = loadCommerceConfig(raw);
  if (command === 'validate') { console.log(JSON.stringify({ valid: true, digest: digest(config), services: config.services.length, paymentPerformed: false })); return; }
  if (command === 'card' && values.service && values.offer && values.origin) { console.log(JSON.stringify(AgentCard.toJSON(createOfferCard(config, values.service, values.offer, values.origin)), null, 2)); return; }
  if (command !== 'serve' || !values.origin || !values.state || !values.credentials) throw new CommerceError('usage', usage);
  const secrets = JSON.parse(privateFile(values.credentials).toString('utf8')) as {
    callers: Record<string, string>; upstreams: Record<string, string>; upstreamInputEncoding?:Record<string,'data'|'json-text'>; skills?:NativeSkillSettings;
    vaultKeyFile?: string; ownershipChallenges?:Record<string,string>;
  };
  let integration:EnvarIntegration|undefined,syncSettings:{policy:EnvarPolicy;pollIntervalMs?:number;stateDirectory?:string;configDirectory?:string}|undefined;
  if(values['envar-config']){
    syncSettings=JSON.parse(privateFile(values['envar-config']).toString('utf8')) as typeof syncSettings;
    if(!syncSettings?.policy)throw new CommerceError('envar_configuration','Envar settings must include an explicit local policy');
    if(secrets.skills?.discovery?.enabledFromWeb){
      const installed=readdirSync(secrets.skills.skillsDirectory,{withFileTypes:true}).filter(e=>e.isDirectory()&&!e.isSymbolicLink()&&/^[a-z][a-z0-9-]{0,63}$/.test(e.name)).map(e=>e.name);
      syncSettings.policy.allowedServices=[...new Set([...syncSettings.policy.allowedServices,...installed])];
    }
    const tokenFile=resolve(values['envar-credentials']!);privateFile(tokenFile);
    integration=new EnvarIntegration({policy:syncSettings.policy,stateDirectory:syncSettings.stateDirectory??join(dirname(values.state),'envar-state'),configDirectory:syncSettings.configDirectory??join(dirname(values.state),'envar-configs'),token:()=>privateFile(tokenFile).toString('utf8').trim()});
    closers.push(()=>integration!.close());
  }
  const controller = new AbortController();
  const store = new CommerceStore(values.state); closers.push(() => store.close());
  if(integration)config=restoreEnvarConfig(config,integration,store.catalogHistory());
  const needsBalance = Boolean(integration) || Object.values(config.paymentProfiles).length > 0 || store.catalogHistory().some(entry=>Object.values(entry.profiles).length>0);
  let vault: CredentialVault | undefined;
  if (needsBalance) {
    if (!secrets.vaultKeyFile) throw new CommerceError('vault_key', 'Paid services require a private vault key file');
    vault = new CredentialVault(join(dirname(values.state), 'authorizations'), privateFile(secrets.vaultKeyFile));
  }
  let balanceGate: EnvarBalanceGate | undefined;
  if (needsBalance) {
    if (!integration) throw new CommerceError('balance_configuration','Envar balance requires an authenticated Envar seller integration');
    balanceGate = new EnvarBalanceGate({store,vault:vault!,claim:args=>integration!.claimBalancePayment(args)});
  }
  const nativeSkills=secrets.skills?createNativeSkillExecutor(secrets.skills,values.origin,config.agent.name):undefined;
  const discovery=secrets.skills?.discovery?.enabledFromWeb?new SkillDiscovery(secrets.skills,secrets.skills.discovery,values.origin):undefined;
  if(nativeSkills)closers.push(()=>nativeSkills.close());
  const upstreams=new PinnedUpstreams(join(dirname(values.state),'upstream-bindings.json'),secrets.upstreams??{},secrets.upstreamInputEncoding,fetch,controller.signal,nativeSkills?.execute);
  upstreams.prepare(config,store.catalogHistory().map(entry=>entry.service));
  const validateAdapters=(candidate:typeof config)=>{for(const profile of Object.values(candidate.paymentProfiles)){
    if(!balanceGate || !syncSettings?.policy.allowedBalanceAccounts?.includes(profile.accountRef))throw new CommerceError('balance_configuration','Allow this balance receiving account locally');
  }};
  validateAdapters(config);
  const server = new CommerceServer({ config, origin: values.origin, store, ownershipChallenges:secrets.ownershipChallenges,
    authenticate: bearerAuthenticator(secrets.callers), execute: upstreams.execute,
    paymentGate: { handle: async (request, order) => {
      if (!balanceGate) throw new CommerceError('payment_method_unavailable', 'Envar balance is unavailable');
      return balanceGate.handle(request, order);
    } }, onError: (code, orderId) => console.error(JSON.stringify({ code, orderId })) });
  closers.push(async () => { server.stop(); controller.abort(); while (server.isRunning) await new Promise(r => setTimeout(r, 50)); });
  let connection:EnvarSellerRuntime|undefined;
  if(integration){connection=new EnvarSellerRuntime({integration,server,upstreams,pollIntervalMs:syncSettings?.pollIntervalMs,validateConfig:validateAdapters,beforeSync:discovery?()=>discovery.sync(integration!):undefined,onError:code=>console.error(JSON.stringify({code,integration:'envar'}))});closers.push(()=>connection!.stop());}
  const http = listenCommerce(server, values.origin, values.host ?? '127.0.0.1', port(4020)); closers.push(async () => {server.stop();controller.abort();await closeHttp(http)});
  await once(http, 'listening'); connection?.start(); signals(); console.log(JSON.stringify({ listening: port(4020), role: 'seller', paymentMethod: needsBalance ? 'envar_balance' : 'free' }));
}
try { await run(); }
catch (error) {
  for (const close of closers.reverse()) { try { await close(); } catch {} }
  // Only typed errors are safe to print; arbitrary provider failures may echo credentials.
  console.error(error instanceof CommerceError ? `${error.code}: ${error.message}` : 'Startup failed; inspect configuration and private credential file permissions'); process.exitCode = 1;
}
