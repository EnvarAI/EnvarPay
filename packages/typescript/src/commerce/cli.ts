#!/usr/bin/env node
import { readFileSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { MppBuyerOptions } from './mpp-client.js';
import { privateKeyToAccount } from 'viem/accounts';
import { AgentCard } from '@a2a-js/sdk';
import { loadCommerceConfig, loadBuyerPolicy, digest } from './config.js';
import { createOfferCard } from './card.js';
import { CommerceStore } from './store.js';
import { CommerceServer, bearerAuthenticator } from './server.js';
import { EnvarIntegration, type EnvarPolicy } from './envar.js';
import { EnvarSellerRuntime, PinnedUpstreams, restoreEnvarConfig } from './envar-runtime.js';
import { listenCommerce } from './http.js';
import { CredentialVault } from './vault.js';
import { X402Gate } from './x402.js';
import { evmReceiptVerifier, evmSettlementRecovery } from './chain.js';
import { CommerceError } from './types.js';
import { inspectLedger } from './operations.js';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  config: { type: 'string' }, service: { type: 'string' }, offer: { type: 'string' }, origin: { type: 'string' },
  version: { type: 'boolean' }, help: {type:'boolean',short:'h'}, state: { type: 'string' }, credentials: { type: 'string' }, host: { type: 'string' },
  port: { type: 'string' }, directory: { type: 'string' }, 'envar-config': {type:'string'}, 'envar-credentials': {type:'string'},
  after:{type:'string'}, limit:{type:'string'},
} });
const usage = 'envarpay init --directory DIR | inspect --state DB [--after ROW --limit 100] | validate --config seller.json | card --config seller.json --service ID --offer ID --origin URL | serve/buyer-serve --config FILE --credentials FILE --state DB --origin URL';
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
async function loadMppAdapter(path:string):Promise<MppBuyerOptions>{
  privateFile(path);
  const module=await import(pathToFileURL(resolve(path)).href) as {createMppBuyerOptions?:()=>MppBuyerOptions|Promise<MppBuyerOptions>};
  if(typeof module.createMppBuyerOptions!=='function')throw new CommerceError('mpp_adapter_module','Owner-supplied module must export createMppBuyerOptions');
  const options=await module.createMppBuyerOptions();
  if(!options||typeof options.createToken!=='function'||typeof options.recoverToken!=='function'||typeof options.verifyReceipt!=='function')throw new CommerceError('mpp_adapter_module','MPP requires real token creation, original-operation recovery and receipt verification');
  return options;
}
async function run(): Promise<void> {
  if(values.help||positionals.length===0&&!values.version){console.log(usage);return;}
  if (values.version) { console.log(createRequire(import.meta.url)('../../package.json').version); return; }
  const command = positionals[0];
  if(command==='inspect'&&values.state){console.log(JSON.stringify(inspectLedger(values.state,Number(values.after??0),Number(values.limit??100)),null,2));return;}
  if((values['envar-config']||values['envar-credentials'])&&command!=='serve')throw new CommerceError('envar_role','Configuration synchronization is available on seller serve only');
  if(Boolean(values['envar-config'])!==Boolean(values['envar-credentials']))throw new CommerceError('envar_configuration','Supply both --envar-config and --envar-credentials');
  if (command === 'init' && values.directory) {
    mkdirSync(values.directory, { recursive: true, mode: 0o700 });
    for (const [name, source] of [['seller.json', 'seller.json'], ['buyer-policy.json', 'buyer-policy.json']]) {
      writeFileSync(join(values.directory, name!), readFileSync(new URL(`../../examples/${source}`, import.meta.url)), { flag: 'wx', mode: 0o600 });
    }
    writeFileSync(join(values.directory, 'vault.key'), randomBytes(32), { flag: 'wx', mode: 0o600, flush: true });
    console.log(JSON.stringify({ directory: values.directory, configured: false, paymentPerformed: false, next: 'Review placeholder addresses, prices, runtime and private credential files before serve' })); return;
  }
  if (!values.config) throw new CommerceError('usage', usage);
  const raw = JSON.parse(readFileSync(values.config, 'utf8'));
  if (command === 'buyer-serve') {
    if (!values.origin || !values.state || !values.credentials) throw new CommerceError('usage', usage);
    const policy = loadBuyerPolicy(raw);
    const secrets = JSON.parse(privateFile(values.credentials).toString('utf8')) as {
      callers: Record<string, string>; peerTokens: Record<string, string>; peerEndpoints?: Record<string, string>;
      privateKeyFile?: string; vaultKeyFile?: string; rpcUrls?: Record<string, string>; mppAdapterModule?:string;
      peerProxies?: {peerId:string;offerId:string;buyerCaller:string;origin:string;stateDirectory:string;tokens:Record<string,string>;host?:string;port:number;allowPrivateHttp?:boolean;label?:string}[];
    };
    const needsEvm=policy.peers.some(peer=>peer.protocol==='x402'),needsMpp=policy.peers.some(peer=>peer.protocol==='mpp');
    if (!secrets.peerTokens || (needsEvm||needsMpp)&&!secrets.vaultKeyFile) throw new CommerceError('buyer_credentials', 'Paid buyer needs private vault key and peer credentials');
    let signer:ReturnType<typeof privateKeyToAccount>|undefined;
    if(needsEvm){
      if(!secrets.privateKeyFile||!secrets.rpcUrls)throw new CommerceError('buyer_credentials','x402 peers require local signer and RPC configuration');
      const key=privateFile(secrets.privateKeyFile).toString('utf8').trim();
      if(!/^0x[0-9a-fA-F]{64}$/.test(key))throw new CommerceError('buyer_key','Signer file must contain one 32-byte 0x-prefixed private key');
      signer=privateKeyToAccount(key as `0x${string}`);
    }
    if(needsMpp&&!secrets.mppAdapterModule)throw new CommerceError('mpp_adapter_module','MPP peers require an explicit local adapter module for authorized funding and receipt verification');
    const mpp=needsMpp?await loadMppAdapter(secrets.mppAdapterModule!):undefined;
    const { BuyerStore } = await import('./buyer-store.js');
    const { CommerceBuyer } = await import('./buyer.js');
    const { BuyerManagement, listenBuyerManagement } = await import('./management.js');
    const store = new BuyerStore(values.state); closers.push(() => store.close());
    const buyer = new CommerceBuyer({ policy, store, vault: secrets.vaultKeyFile?new CredentialVault(join(dirname(values.state), 'buyer-authorizations'), privateFile(secrets.vaultKeyFile)):undefined,
      signer, mpp, peerTokens: secrets.peerTokens, peerEndpoints: secrets.peerEndpoints,
      ...(needsEvm?{verifyReceipt:evmReceiptVerifier(secrets.rpcUrls!),...evmSettlementRecovery(secrets.rpcUrls!)}:{}) });
    closers.push(() => buyer.stop());
    if(secrets.peerProxies?.length){
      if(secrets.peerProxies.length>8)throw new CommerceError('proxy_limit','Configure at most8 explicit peer proxies per buyer');
      const {A2APeerProxy,listenPeerProxy}=await import('./peer-proxy.js');
      for(const settings of secrets.peerProxies){
        if(Object.keys(settings.tokens).some(token=>Object.hasOwn(secrets.callers,token)))throw new CommerceError('proxy_token_scope','Agent proxy tokens must differ from owner management credentials');
        if(!Number.isInteger(settings.port)||settings.port<1||settings.port>65535)throw new CommerceError('proxy_port','Invalid proxy listen port');
        const proxy=new A2APeerProxy({...settings,buyer});
        closers.push(async()=>{await proxy.stop();proxy.close();});
        const listener=listenPeerProxy(proxy,settings.host??'127.0.0.1',settings.port);
        closers.push(()=>closeHttp(listener));await once(listener,'listening');
      }
    }
    const management = new BuyerManagement({ buyer, origin: values.origin, authenticate: bearerAuthenticator(secrets.callers) });
    const http = listenBuyerManagement(management, values.origin, values.host ?? '127.0.0.1', port(4021));
    closers.push(() => closeHttp(http)); await once(http, 'listening'); buyer.start(); signals();
    console.log(JSON.stringify({ listening: port(4021), role: 'buyer', paymentsEnabled: policy.paymentsEnabled })); return;
  }
  let config = loadCommerceConfig(raw);
  if (command === 'validate') { console.log(JSON.stringify({ valid: true, digest: digest(config), services: config.services.length, paymentPerformed: false })); return; }
  if (command === 'card' && values.service && values.offer && values.origin) { console.log(JSON.stringify(AgentCard.toJSON(createOfferCard(config, values.service, values.offer, values.origin)), null, 2)); return; }
  if (command !== 'serve' || !values.origin || !values.state || !values.credentials) throw new CommerceError('usage', usage);
  const secrets = JSON.parse(privateFile(values.credentials).toString('utf8')) as {
    callers: Record<string, string>; upstreams: Record<string, string>; upstreamInputEncoding?:Record<string,'data'|'json-text'>; payers?: Record<string, string>;
    vaultKeyFile?: string; rpcUrls?: Record<string, string>; mppHmacKeyFile?: string; ownershipChallenges?:Record<string,string>;
    stripe?: Record<string, { secretKeyFile: string; accountId: string; merchantProfile: string; mode: 'test' | 'live' }>;
  };
  let integration:EnvarIntegration|undefined,syncSettings:{policy:EnvarPolicy;pollIntervalMs?:number;stateDirectory?:string;configDirectory?:string}|undefined;
  if(values['envar-config']){
    syncSettings=JSON.parse(privateFile(values['envar-config']).toString('utf8')) as typeof syncSettings;
    if(!syncSettings?.policy)throw new CommerceError('envar_configuration','Envar settings must include an explicit local policy');
    const tokenFile=resolve(values['envar-credentials']!);privateFile(tokenFile);
    integration=new EnvarIntegration({policy:syncSettings.policy,stateDirectory:syncSettings.stateDirectory??join(dirname(values.state),'envar-state'),configDirectory:syncSettings.configDirectory??join(dirname(values.state),'envar-configs'),token:()=>privateFile(tokenFile).toString('utf8').trim()});
    closers.push(()=>integration!.close());
  }
  const controller = new AbortController();
  const store = new CommerceStore(values.state); closers.push(() => store.close());
  if(integration)config=restoreEnvarConfig(config,integration,store.catalogHistory());
  const protocols = new Set(Object.values(config.paymentProfiles).map(p => p.adapter));
  for(const historical of store.catalogHistory())for(const profile of Object.values(historical.profiles))protocols.add(profile.adapter);
  if(syncSettings?.policy.allowedX402.length)protocols.add('x402');
  if(syncSettings?.policy.allowedMppAccounts.length)protocols.add('mpp');
  let vault: CredentialVault | undefined;
  if (protocols.size) {
    if (!secrets.vaultKeyFile) throw new CommerceError('vault_key', 'Paid services require a private vault key file');
    vault = new CredentialVault(join(dirname(values.state), 'authorizations'), privateFile(secrets.vaultKeyFile));
  }
  const gates: Record<string, { handle: X402Gate['handle'] }> = {};
  let stripeRecipientFor: ((accountRef: string) => string | undefined) | undefined;
  if (protocols.has('x402')) {
    if (!secrets.payers || !secrets.rpcUrls) throw new CommerceError('x402_configuration', 'x402 requires explicit caller-payer bindings and network RPCs');
    const gate = new X402Gate({ store, vault: vault!, payerFor: caller => secrets.payers?.[caller], verifyReceipt:evmReceiptVerifier(secrets.rpcUrls),...evmSettlementRecovery(secrets.rpcUrls) });
    await gate.check(Object.values(config.paymentProfiles).filter((p):p is Extract<import('./types.js').PaymentProfile,{adapter:'x402'}>=>p.adapter==='x402'));
    gates.x402=gate;
  }
  if (protocols.has('mpp')) {
    if (!secrets.stripe || !secrets.mppHmacKeyFile) throw new CommerceError('mpp_configuration', 'MPP requires private Stripe credentials and a separate challenge key');
    const { MppGate } = await import('./mpp.js'), { stripeProvider } = await import('./stripe-provider.js');
    const providers = Object.fromEntries(Object.entries(secrets.stripe).map(([ref, p]) => [ref, stripeProvider({ ...p, secretKey: privateFile(p.secretKeyFile).toString('utf8').trim() })]));
    const hmacKey=privateFile(secrets.mppHmacKeyFile);
    if(hmacKey.length<32)throw new CommerceError('mpp_hmac_key','MPP requires a private challenge key of at least32 random bytes');
    const gate = new MppGate({ store, vault: vault!, origin: values.origin, hmacSecret: hmacKey.toString('base64'), providers });
    await gate.check(); gates.mpp = gate; stripeRecipientFor = ref => gate.merchantRecipient(ref);
  }
  const upstreams=new PinnedUpstreams(join(dirname(values.state),'upstream-bindings.json'),secrets.upstreams,secrets.upstreamInputEncoding,fetch,controller.signal);
  upstreams.prepare(config,store.catalogHistory().map(entry=>entry.service));
  const validateAdapters=(candidate:typeof config)=>{for(const profile of Object.values(candidate.paymentProfiles)){
    if(!gates[profile.adapter])throw new CommerceError('payment_method_unavailable','Configure the payment adapter locally before enabling this service');
    if(profile.adapter==='x402'&&!secrets.rpcUrls?.[profile.network])throw new CommerceError('x402_configuration','Configure the required network RPC locally');
    if(profile.adapter==='mpp'&&!stripeRecipientFor?.(profile.accountRef))throw new CommerceError('mpp_configuration','Configure and verify the merchant account locally');
  }};
  validateAdapters(config);
  const server = new CommerceServer({ config, origin: values.origin, store, stripeRecipientFor, ownershipChallenges:secrets.ownershipChallenges,
    authenticate: bearerAuthenticator(secrets.callers), execute: upstreams.execute,
    paymentGate: { handle: async (request, order) => {
      const adapter = order.quote.paymentProfile?.adapter, gate = adapter ? gates[adapter] : undefined;
      if (!gate) throw new CommerceError('payment_method_unavailable', 'Configured payment adapter is unavailable');
      return gate.handle(request, order);
    } }, onError: (code, orderId) => console.error(JSON.stringify({ code, orderId })) });
  closers.push(async () => { server.stop(); controller.abort(); while (server.isRunning) await new Promise(r => setTimeout(r, 50)); });
  let connection:EnvarSellerRuntime|undefined;
  if(integration){connection=new EnvarSellerRuntime({integration,server,upstreams,pollIntervalMs:syncSettings?.pollIntervalMs,validateConfig:validateAdapters,onError:code=>console.error(JSON.stringify({code,integration:'envar'}))});closers.push(()=>connection!.stop());}
  const http = listenCommerce(server, values.origin, values.host ?? '127.0.0.1', port(4020)); closers.push(async () => {server.stop();controller.abort();await closeHttp(http)});
  await once(http, 'listening'); connection?.start(); signals(); console.log(JSON.stringify({ listening: port(4020), role: 'seller', paidTransports: [...protocols] }));
}
try { await run(); }
catch (error) {
  for (const close of closers.reverse()) { try { await close(); } catch {} }
  // Only typed errors are safe to print; arbitrary provider failures may echo credentials.
  console.error(error instanceof CommerceError ? `${error.code}: ${error.message}` : 'Startup failed; inspect configuration and private credential file permissions'); process.exitCode = 1;
}
