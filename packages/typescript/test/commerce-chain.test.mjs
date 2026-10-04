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
 let mode='valid';
 const server=createServer(async(req,res)=>{
  let text='';for await(const c of req)text+=c;const rpc=JSON.parse(text);let result;
  if(rpc.method==='eth_chainId')result='0x14a34';
  else if(rpc.method==='eth_blockNumber')result=mode==='unconfirmed'?'0xa':'0xc';
  else if(rpc.method==='eth_getLogs')result=mode==='missing-nonce'?[]:[authLog()];
  else if(rpc.method==='eth_getBlockByNumber')result={number:'0xa',hash:mode==='reorg'?'0x'+'6'.repeat(64):block,transactions:[],timestamp:'0x1234',gasLimit:'0x1',gasUsed:'0x1',extraData:'0x',miner:payee};
  else if(rpc.method==='eth_getTransactionReceipt'){
   const logs=[transferLog(),authLog()];
   if(mode==='wrong-amount')logs[0].data=encodeAbiParameters([{type:'uint256'}],[1n]);
   if(mode==='wrong-asset')logs[0].address=payee;
   if(mode==='missing-nonce')logs.pop();
   result={transactionHash:tx,transactionIndex:'0x0',blockHash:block,blockNumber:'0xa',from:payer,to:asset,cumulativeGasUsed:'0x1',gasUsed:'0x1',effectiveGasPrice:'0x1',contractAddress:null,logs,logsBloom:'0x'+'0'.repeat(512),status:mode==='reverted'?'0x0':'0x1',type:'0x2'};
  }else throw new Error('Unexpected RPC '+rpc.method);
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result}));
 });server.listen(0,'127.0.0.1');await once(server,'listening');
 try{
  const verify=evmReceiptVerifier({'eip155:84532':`http://127.0.0.1:${server.address().port}`});
  const receipt={success:true,payer,transaction:tx,network:'eip155:84532'};
  const payload={payload:{authorization:{from:payer,to:payee,value:'3000000',nonce}}};
  const requirements={network:'eip155:84532',asset,payTo:payee,amount:'3000000'};
  assert.equal(await verify(receipt,payload,requirements),true);
  const recovery=evmSettlementRecovery({'eip155:84532':`http://127.0.0.1:${server.address().port}`});
  assert.equal(await recovery.checkpoint(requirements),'0');
  assert.equal((await recovery.findOriginalReceipt(payload,requirements,'0')).transaction,tx);
  mode='missing-nonce';assert.equal(await recovery.findOriginalReceipt(payload,requirements,'0'),undefined);
  for(const bad of ['wrong-amount','wrong-asset','missing-nonce','reorg','unconfirmed','reverted']){mode=bad;assert.equal(await verify(receipt,payload,requirements),false,bad);}
 }finally{await new Promise(r=>server.close(r));}
});
