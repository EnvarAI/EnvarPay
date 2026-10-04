#!/usr/bin/env node
import { readFileSync, statSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import { AgentCard } from '@a2a-js/sdk';
import { loadCommerceConfig, digest } from './config.js';
import { createOfferCard } from './card.js';
import { CommerceStore } from './store.js';
import { CommerceServer, bearerAuthenticator } from './server.js';
import { nativeA2AExecutor } from './upstream.js';
import { listenCommerce } from './http.js';
import { CredentialVault } from './vault.js';
import { X402Gate } from './x402.js';
import { evmReceiptVerifier, evmSettlementRecovery } from './chain.js';
import { dirname,join } from 'node:path';

let openedStore:CommerceStore|undefined;
const {values,positionals}=parseArgs({allowPositionals:true,options:{config:{type:'string'},service:{type:'string'},offer:{type:'string'},origin:{type:'string'},version:{type:'boolean'},state:{type:'string'},credentials:{type:'string'},host:{type:'string'},port:{type:'string'}}});
try {
  if(values.version) console.log(createRequire(import.meta.url)('../../package.json').version);
  else {
    if(!values.config) throw new Error('Usage: envarpay validate --config seller.json | envarpay card --config seller.json --service ID --offer ID --origin https://seller.example');
    const config=loadCommerceConfig(JSON.parse(readFileSync(values.config,'utf8')));
    if(positionals[0]==='validate') console.log(JSON.stringify({valid:true,digest:digest(config),services:config.services.length,paymentPerformed:false}));
    else if(positionals[0]==='card' && values.service && values.offer && values.origin) console.log(JSON.stringify(AgentCard.toJSON(createOfferCard(config,values.service,values.offer,values.origin)),null,2));
    else if(positionals[0]==='serve'&&values.origin&&values.state&&values.credentials){
      if((statSync(values.credentials).mode&0o077)!==0)throw new Error('Credentials must be owner-only (chmod 600)');
      const secrets=JSON.parse(readFileSync(values.credentials,'utf8')) as {callers:Record<string,string>;upstreams:Record<string,string>;payers?:Record<string,string>;vaultKeyFile?:string;rpcUrls?:Record<string,string>};
      const port=Number(values.port??4020);if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid listen port');
      const controller=new AbortController();
      const store=openedStore=new CommerceStore(values.state);
      let paymentGate:X402Gate|undefined;
      if(Object.values(config.paymentProfiles).some(p=>p.adapter==='x402')){
        if(!secrets.payers||!secrets.vaultKeyFile||!secrets.rpcUrls)throw new Error('Paid x402 service requires buyer payer bindings, vault key file and network RPCs');
        if((statSync(secrets.vaultKeyFile).mode&0o077)!==0)throw new Error('Vault key must be owner-only');
        const key=readFileSync(secrets.vaultKeyFile);const vault=new CredentialVault(join(dirname(values.state),'authorizations'),key);
        paymentGate=new X402Gate({store,vault,payerFor:caller=>secrets.payers?.[caller],verifyReceipt:evmReceiptVerifier(secrets.rpcUrls),...evmSettlementRecovery(secrets.rpcUrls)});
      }
      const server=new CommerceServer({config,origin:values.origin,store,authenticate:bearerAuthenticator(secrets.callers),execute:nativeA2AExecutor(secrets.upstreams,fetch,controller.signal),paymentGate,onError:(code,orderId)=>console.error(JSON.stringify({code,orderId}))});
      const http=listenCommerce(server,values.origin,values.host??'127.0.0.1',port);
      console.log(JSON.stringify({listening:port,paidTransport:paymentGate?'x402':'none'}));
      const stop=()=>{server.stop();http.close();controller.abort();const drain=setInterval(()=>{if(!server.isRunning){clearInterval(drain);store.close();process.exit(0);}},100);setTimeout(()=>{process.exit(1);},10000).unref();};
      process.once('SIGTERM',stop);process.once('SIGINT',stop);
    }
    else throw new Error('Unknown command or missing service, offer or origin');
  }
} catch(error) {
  openedStore?.close();
  console.error(error instanceof Error?error.message:'Configuration failed');
  process.exitCode=1;
}
