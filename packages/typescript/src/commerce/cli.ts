#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import { AgentCard } from '@a2a-js/sdk';
import { loadCommerceConfig, digest } from './config.js';
import { createOfferCard } from './card.js';

const {values,positionals}=parseArgs({allowPositionals:true,options:{config:{type:'string'},service:{type:'string'},offer:{type:'string'},origin:{type:'string'},version:{type:'boolean'}}});
try {
  if(values.version) console.log(createRequire(import.meta.url)('../../package.json').version);
  else {
    if(!values.config) throw new Error('Usage: envarpay validate --config seller.json | envarpay card --config seller.json --service ID --offer ID --origin https://seller.example');
    const config=loadCommerceConfig(JSON.parse(readFileSync(values.config,'utf8')));
    if(positionals[0]==='validate') console.log(JSON.stringify({valid:true,digest:digest(config),services:config.services.length,paymentPerformed:false}));
    else if(positionals[0]==='card' && values.service && values.offer && values.origin) console.log(JSON.stringify(AgentCard.toJSON(createOfferCard(config,values.service,values.offer,values.origin)),null,2));
    else throw new Error('Unknown command or missing service, offer or origin');
  }
} catch(error) {
  console.error(error instanceof Error?error.message:'Configuration failed');
  process.exitCode=1;
}
