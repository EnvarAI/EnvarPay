import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { HostedWalletBuyer } from '../dist/commerce/hosted-buyer.js';
import { MemoryCredentialVault, openHosted, sealHosted } from '../dist/commerce/hosted-crypto.js';
import { hostedSellerFetch, publicAddress } from '../dist/commerce/hosted-network.js';
import { BuyerStore } from '../dist/commerce/buyer-store.js';

const key=Buffer.alloc(32,7),issuer='https://wallet.example';
function context(){
  const merchant=randomUUID(),messageId=randomUUID(),cardUrl='https://seller.example/services/echo/v1/offers/balance/agent-card.json';
  return {version:1,owner:'alice',wallet:{issuer,environment:'sandbox',principal:'alice-web',credential:'t'.repeat(43)},
    preview:{cardUrl,messageId,offerId:'balance',input:{prompt:'hello'}},
    policy:{policyVersion:1,paymentsEnabled:true,approval:'per_purchase',peers:[{id:'seller',cardUrl,protocol:'mpp',method:'envar',currency:'cny',recipient:merchant,issuer,environment:'sandbox',maxPerPurchase:'500'}],budgets:[{currency:'cny',maxTotal:'500',period:'cumulative'}]}};
}
function hostFixture({approved=false,fenced=false,owner='alice'}={}){
  const id=randomUUID(),ctx=context();let calls=0,version=0,released=false;
  const row={id,owner_account_id:owner,context_ciphertext:sealHosted(key,id,'context',ctx),state_ciphertext:Buffer.alloc(0),confirmed_at:approved?new Date():null,version:'0',lease:null};
  const buyer=new HostedWalletBuyer({databaseUrl:'postgresql://unused',stateKey:key,walletIssuer:issuer,environment:'sandbox',walletFetch:async()=>{calls++;throw Error('fixture network reached');},sellerFetch:async()=>{calls++;throw Error('fixture seller reached');}});
  buyer.pool.query=async(sql,args)=>{
    if(sql.includes('RETURNING id,')){row.lease=args[1];row.version=String(++version);return {rowCount:1,rows:[{...row}]};}
    if(sql.includes('RETURNING version')){
      if(fenced)return {rowCount:0,rows:[]};
      assert.equal(args[1],row.lease);assert.equal(args[2],row.version);row.state_ciphertext=args[3];row.version=String(++version);return {rowCount:1,rows:[{version:row.version}]};
    }
    if(sql.includes('SET lease=NULL')){released=true;return {rowCount:1,rows:[]};}
    throw Error('Unexpected SQL shape');
  };
  return {id,ctx,row,buyer,calls:()=>calls,released:()=>released};
}

test('hosted encrypted state is bound to operation and purpose',()=>{
  const id=randomUUID(),value={owner:'alice',token:'fixture-only'};
  const envelope=sealHosted(key,id,'context',value);
  assert.deepEqual(openHosted(key,id,'context',envelope),value);
  assert.throws(()=>openHosted(key,randomUUID(),'context',envelope),{code:'hosted_state_integrity'});
  assert.throws(()=>openHosted(key,id,'state',envelope),{code:'hosted_state_integrity'});
  const changed=Buffer.from(envelope);changed[14]^=1;
  assert.throws(()=>openHosted(key,id,'context',changed),{code:'hosted_state_integrity'});
});

test('a pending website purchase cannot spend before the durable BFF approval',async()=>{
  const f=hostFixture();try{
    await assert.rejects(f.buyer.run(f.id,'confirm',{messageId:f.ctx.preview.messageId,quoteToken:'fixture'}),{code:'hosted_approval'});
    assert.equal(f.calls(),0);assert(f.released());
  }finally{await f.buyer.close();}
});

test('a fenced checkpoint prevents the next external request',async()=>{
  const f=hostFixture({fenced:true});try{
    await assert.rejects(f.buyer.run(f.id,'preview'),{code:'hosted_fenced'});
    assert.equal(f.calls(),0);assert(f.released());
  }finally{await f.buyer.close();}
});

test('another tenant cannot reuse a valid encrypted context',async()=>{
  const f=hostFixture({owner:'bob'});try{
    await assert.rejects(f.buyer.run(f.id,'preview'),{code:'hosted_context'});assert.equal(f.calls(),0);
  }finally{await f.buyer.close();}
});

test('wallet projection restoration preserves original authorization and reserved budget',()=>{
  const store=new BuyerStore(':memory:'),vault=new MemoryCredentialVault(),ref=vault.put({paymentToken:'fixture'});
  const record={id:randomUUID(),caller:'alice',messageId:randomUUID(),protocol:'mpp',mppMethod:'envar',quote:{currency:'cny',amount:'500'},state:'submitted',paymentState:'unknown',tokenOperationId:'original-operation',credentialRef:ref};
  try{
    store.restoreWalletState({version:1,rows:[{budgetState:'reserved',record}]},'alice');
    const saved=store.get(record.id,'alice');assert.equal(saved.state,'unknown');assert.equal(saved.tokenOperationId,'original-operation');assert.equal(saved.credentialRef,ref);
    assert.deepEqual(store.usage('cny'),{reserved:'500',spent:'0'});
    assert.deepEqual(new MemoryCredentialVault(vault.snapshot()).get(ref),{paymentToken:'fixture'});
    const foreign=new BuyerStore(':memory:');try{assert.throws(()=>foreign.restoreWalletState(store.exportWalletState(),'bob'),{code:'hosted_state'});}finally{foreign.close();}
  }finally{store.close();}
});

test('hosted seller requests reject private and mapped-private addresses',async()=>{
  for(const address of ['127.0.0.1','10.0.0.1','169.254.169.254','192.168.1.1','::1','::ffff:127.0.0.1','2001:db8::1'])assert.equal(publicAddress(address),false,address);
  assert.equal(publicAddress('8.8.8.8'),true);
  await assert.rejects(hostedSellerFetch()('https://127.0.0.1/'),{code:'hosted_private_endpoint'});
  await assert.rejects(hostedSellerFetch()('http://localhost/'),{code:'hosted_endpoint'});
});

test('explicit local sandbox HTTP is pinned and does not follow redirects',async()=>{
  let hits=0;const server=createServer((_req,res)=>{hits++;res.writeHead(302,{Location:'http://169.254.169.254/'});res.end();});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  try{const result=await hostedSellerFetch(true)(`http://127.0.0.1:${server.address().port}/`);assert.equal(result.status,302);assert.equal(hits,1);}
  finally{await new Promise(resolve=>server.close(resolve));}
});
