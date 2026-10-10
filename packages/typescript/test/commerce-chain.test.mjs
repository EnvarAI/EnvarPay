import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {encodeEventTopics,encodeAbiParameters,parseAbi} from 'viem';
import {evmReceiptVerifier,evmSettlementRecovery} from '../dist/commerce/chain.js';

const asset='0x036CbD53842c5426634e7929541eC2318f3dCF7e',payer='0x'+'1'.repeat(40),payee='0x'+'2'.repeat(40),nonce='0x'+'3'.repeat(64),tx='0x'+'4'.repeat(64),block='0x'+'5'.repeat(64);
const transfer=parseAbi(['event Transfer(address indexed from,address indexed to,uint256 value)']);
const authorization=parseAbi(['event AuthorizationUsed(address indexed authorizer,bytes32 indexed nonce)']);
const log=(topics,data,index)=>({address:asset,topics,data,blockNumber:'0xa',blockHash:block,transactionHash:tx,transactionIndex:'0x0',logIndex:'0x'+index.toString(16),removed:false});
const transferLog=()=>log(encodeEventTopics({abi:transfer,eventName:'Transfer',args:{from:payer,to:payee}}),encodeAbiParameters([{type:'uint256'}],[3000000n]),0);
const authLog=()=>log(encodeEventTopics({abi:authorization,eventName:'AuthorizationUsed',args:{authorizer:payer,nonce}}),'0x',1);

test('chain receipt must match canonical block, confirmations, Transfer and signed nonce',async()=>{
 let mode='valid',receiptReads=0;const ranges=[],failures=[],requests=[];
 const server=createServer(async(req,res)=>{
  let text='';for await(const c of req)text+=c;const rpc=JSON.parse(text);let result;
  requests.push(rpc);
  if(failures[0]?.method===rpc.method){
   const failure=failures.shift();res.setHeader('Content-Type','application/json');
   if(failure.status){res.statusCode=failure.status;res.end(JSON.stringify({error:'RPC temporarily unavailable'}));return;}
   res.end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,error:{code:failure.code??-32000,message:'RPC temporarily unavailable'}}));return;
  }
  if(rpc.method==='eth_chainId')result='0x14a34';
  else if(rpc.method==='eth_blockNumber')result=mode==='bounded-recovery'?'0x190':mode==='unconfirmed'||mode==='delayed'&&receiptReads<3?'0xa':'0xc';
  else if(rpc.method==='eth_getLogs'){
   if(mode==='bounded-recovery'){
    const from=BigInt(rpc.params[0].fromBlock),to=BigInt(rpc.params[0].toBlock);ranges.push([Number(from),Number(to)]);
    if(to-from>=200n){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,error:{code:-32614,message:'eth_getLogs is limited to a 200 range'}}));return;}
    result=from<=300n&&to>=300n?[{...authLog(),blockNumber:'0x12c'}]:[];
   }else result=mode==='missing-nonce'?[]:[authLog()];
  }
  else if(rpc.method==='eth_getBlockByNumber')result={number:'0xa',hash:mode==='reorg'?'0x'+'6'.repeat(64):block,transactions:[],timestamp:'0x1234',gasLimit:'0x1',gasUsed:'0x1',extraData:'0x',miner:payee};
  else if(rpc.method==='eth_getTransactionReceipt'){
   receiptReads++;
   const logs=[transferLog(),authLog()];
   if(mode==='wrong-amount')logs[0].data=encodeAbiParameters([{type:'uint256'}],[1n]);
   if(mode==='wrong-asset')logs[0].address=payee;
   if(mode==='missing-nonce')logs.pop();
   result=mode==='delayed'&&receiptReads===1?null:{transactionHash:mode==='wrong-hash'?'0x'+'7'.repeat(64):tx,transactionIndex:'0x0',blockHash:block,blockNumber:'0xa',from:payer,to:asset,cumulativeGasUsed:'0x1',gasUsed:'0x1',effectiveGasPrice:'0x1',contractAddress:null,logs,logsBloom:'0x'+'0'.repeat(512),status:mode==='reverted'?'0x0':'0x1',type:'0x2'};
  }else throw new Error('Unexpected RPC '+rpc.method);
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result}));
 });server.listen(0,'127.0.0.1');await once(server,'listening');
 try{
  const urls={'eip155:84532':`http://127.0.0.1:${server.address().port}`};
  const verify=evmReceiptVerifier(urls,2,0);
  const receipt={success:true,payer,transaction:tx,network:'eip155:84532'};
  const payload={payload:{authorization:{from:payer,to:payee,value:'3000000',nonce}}};
  const requirements={network:'eip155:84532',asset,payTo:payee,amount:'3000000'};
  assert.equal(await verify(receipt,payload,requirements),true);
  const recovery=evmSettlementRecovery({'eip155:84532':`http://127.0.0.1:${server.address().port}`});
  assert.equal(await recovery.checkpoint(requirements),'0');
  assert.equal((await recovery.findOriginalReceipt(payload,requirements,'0')).transaction,tx);
  mode='missing-nonce';assert.equal(await recovery.findOriginalReceipt(payload,requirements,'0'),undefined);
  mode='bounded-recovery';assert.equal((await recovery.findOriginalReceipt(payload,requirements,'0')).transaction,tx);
  assert.deepEqual(ranges,[[0,199],[200,399]],'original nonce lookup respects the public RPC range limit');
  for(const bad of ['wrong-amount','wrong-asset','wrong-hash','missing-nonce','reorg','unconfirmed','reverted']){mode=bad;assert.equal(await verify(receipt,payload,requirements),false,bad);}
  mode='delayed';receiptReads=0;
  assert.equal(await evmReceiptVerifier(urls,2,4000)(receipt,payload,requirements),true);
  assert.equal(receiptReads,3,'waits for visibility and confirmation depth using the same transaction');
  mode='unconfirmed';receiptReads=0;
  assert.equal(await evmReceiptVerifier(urls,2,50)(receipt,payload,requirements),false);
  assert.equal(receiptReads,1,'bounded wait does not relax the required depth');
  mode='valid';receiptReads=0;requests.length=0;
  failures.push({method:'eth_chainId',code:-32011},{method:'eth_getTransactionReceipt',status:429},{method:'eth_getBlockByNumber',status:503},{method:'eth_blockNumber',code:-32005});
  assert.equal(await evmReceiptVerifier(urls,2,6000)(receipt,payload,requirements),true);
  assert.equal(failures.length,0,'transient failures at every receipt-verification stage are retried');
  assert.ok(requests.every(r=>['eth_chainId','eth_getTransactionReceipt','eth_getBlockByNumber','eth_blockNumber'].includes(r.method)),'retries only read chain data');
  assert.ok(requests.filter(r=>r.method==='eth_getTransactionReceipt').every(r=>r.params[0]===tx),'retries keep the exact original transaction');
  requests.length=0;failures.push({method:'eth_chainId',status:401});
  await assert.rejects(evmReceiptVerifier(urls,2,6000)(receipt,payload,requirements));
  assert.equal(requests.length,1,'permanent authentication errors are not retried');
  requests.length=0;failures.push({method:'eth_chainId',code:-32011});
  await assert.rejects(evmReceiptVerifier(urls,2,50)(receipt,payload,requirements));
  assert.equal(requests.length,1,'the shared wait budget bounds rate-limit retries');
  for(const duration of [-1,30001,NaN])assert.throws(()=>evmReceiptVerifier(urls,2,duration),{code:'confirmation_policy'});
 }finally{await new Promise(r=>server.close(r));}
});

test('expired-unused proof requires exact official-token state at a canonical finalized block',async()=>{
 let mode='valid';const seen=[];
 const server=createServer(async(req,res)=>{
  let text='';for await(const part of req)text+=part;const rpc=JSON.parse(text);seen.push(rpc);let result;
  if(mode==='rpc-error'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,error:{code:-32000,message:'RPC unavailable'}}));return;}
  if(rpc.method==='eth_chainId')result=mode==='wrong-chain'?'0x2105':'0x14a34';
  else if(rpc.method==='eth_getBlockByNumber'){
   if(rpc.params[0]==='finalized'&&mode==='no-finalized'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,error:{code:-32602,message:'Unsupported finalized tag'}}));return;}
   const changed=mode==='reorg'&&rpc.params[0]!=='finalized';
   result={number:'0xa',hash:changed?'0x'+'6'.repeat(64):block,transactions:[],timestamp:mode==='before-expiry'?'0x63':'0x64',gasLimit:'0x1',gasUsed:'0x1',extraData:'0x',miner:payee};
  }else if(rpc.method==='eth_call'){
   assert.equal(rpc.params[0].to.toLowerCase(),asset.toLowerCase());assert.equal(rpc.params[1],'0xa');
   result=mode==='malformed-state'?'0x':encodeAbiParameters([{type:'bool'}],[mode==='used']);
  }else throw new Error('Unexpected proof RPC '+rpc.method);
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result}));
 });server.listen(0,'127.0.0.1');await once(server,'listening');
 try{
  const recovery=evmSettlementRecovery({'eip155:84532':`http://127.0.0.1:${server.address().port}`});
  const payload={payload:{authorization:{from:payer,to:payee,value:'100',nonce,validAfter:'10',validBefore:'100'}}};
  const requirements={network:'eip155:84532',asset,payTo:payee,amount:'100'};
  const proof=await recovery.expiredUnusedProof(payload,requirements);
  assert.equal(proof.expiredUnused,true);assert.equal(proof.finality,'finalized');assert.equal(proof.blockTimestamp,'100');assert.equal(proof.authorizationUsed,false);
  assert.deepEqual(seen.map(x=>x.method),['eth_chainId','eth_getBlockByNumber','eth_call','eth_getBlockByNumber']);
  assert.equal(seen[1].params[0],'finalized');assert.equal(seen[3].params[0],'0xa');
  for(const bad of ['before-expiry','used','wrong-chain','reorg','rpc-error','no-finalized','malformed-state']){mode=bad;assert.equal(await recovery.proveExpiredUnused(payload,requirements),false,bad);}
  mode='valid';const requests=seen.length;
  assert.equal(await recovery.proveExpiredUnused(payload,{...requirements,asset:payee}),false);
  assert.equal(await recovery.proveExpiredUnused(payload,{...requirements,amount:'101'}),false);
  assert.equal(await recovery.proveExpiredUnused({...payload,payload:{authorization:{...payload.payload.authorization,nonce:'bad'}}},requirements),false);
  assert.equal(await recovery.proveExpiredUnused({...payload,payload:{authorization:{...payload.payload.authorization,validAfter:'101'}}},requirements),false);
  assert.equal(seen.length,requests,'malformed or mismatched inputs fail before network access');
  assert.equal(await recovery.proveExpiredUnused(payload,requirements),true);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
