import {createPublicClient,http,decodeEventLog,parseAbi,TransactionReceiptNotFoundError,type Hex} from 'viem';
import type {PaymentPayload,PaymentRequirements,SettleResponse} from '@x402/core/types';
import {CommerceError} from './types.js';
import {validateUrl} from './config.js';

const abi=parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)']);
const authorizationAbi=parseAbi(['event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)']);
const authorizationStateAbi=parseAbi(['function authorizationState(address authorizer,bytes32 nonce) view returns (bool)']);
const officialUsdc:Readonly<Record<string,string>>={
  'eip155:84532':'0x036cbd53842c5426634e7929541ec2318f3dcf7e',
  'eip155:8453':'0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
};
export interface ExpiredUnusedProof {
  expiredUnused:true; network:string; asset:string; payer:string; nonce:string;
  validAfter:string; validBefore:string; blockNumber:string; blockHash:string; blockTimestamp:string;
  finality:'finalized'; authorizationUsed:false;
}

/** Checks the canonical chain receipt and exact official-token Transfer. */
export function evmReceiptVerifier(rpcUrls:Readonly<Record<string,string>>,confirmations=2,confirmationWaitMs=12000){
  if(!Number.isInteger(confirmations)||confirmations<1)throw new CommerceError('confirmation_policy','Positive confirmation depth required');
  if(!Number.isInteger(confirmationWaitMs)||confirmationWaitMs<0||confirmationWaitMs>30000)throw new CommerceError('confirmation_policy','Confirmation wait must be between 0 and 30000 milliseconds');
  return async(receipt:SettleResponse,payload:PaymentPayload,requirements:PaymentRequirements):Promise<boolean>=>{
    const rpc=rpcUrls[requirements.network];if(!rpc)throw new CommerceError('rpc_missing','Configure the settlement network RPC');
    validateUrl(rpc,true);
    const chainId=Number(requirements.network.split(':')[1]);
    if(!Number.isSafeInteger(chainId)||!/^0x[0-9a-fA-F]{64}$/.test(receipt.transaction)||receipt.network!==requirements.network)return false;
    const client=createPublicClient({transport:http(rpc,{timeout:15000,retryCount:0})});
    if(await client.getChainId()!==chainId)return false;
    const deadline=Date.now()+confirmationWaitMs;
    const wait=async()=>{
      const remaining=deadline-Date.now();if(remaining<=0)return false;
      await new Promise(resolve=>setTimeout(resolve,Math.min(1000,remaining)));return Date.now()<deadline;
    };
    let mined:Awaited<ReturnType<typeof client.getTransactionReceipt>>;
    for(;;){
      try{mined=await client.getTransactionReceipt({hash:receipt.transaction as Hex});}
      catch(error){
        if(error instanceof TransactionReceiptNotFoundError){if(await wait())continue;return false;}
        throw error;
      }
      if(mined.status!=='success'||mined.transactionHash.toLowerCase()!==receipt.transaction.toLowerCase())return false;
      const block=await client.getBlock({blockNumber:mined.blockNumber});
      if(block.hash!==mined.blockHash)return false;
      const latest=await client.getBlockNumber({cacheTime:0});
      if(latest-mined.blockNumber+1n>=BigInt(confirmations))break;
      if(!await wait())return false;
    }
    const auth=(payload.payload as {authorization?:{from?:string;to?:string;value?:string;nonce?:string}}).authorization;
    if(!auth?.from||!auth.nonce||auth.to?.toLowerCase()!==requirements.payTo.toLowerCase()||auth.value!==requirements.amount)return false;
    if(receipt.payer&&receipt.payer.toLowerCase()!==auth.from.toLowerCase())return false;
    const matches=mined.logs.filter(log=>{
      if(log.address.toLowerCase()!==requirements.asset.toLowerCase())return false;
      try{const event=decodeEventLog({abi,data:log.data,topics:log.topics});return event.args.from.toLowerCase()===auth.from!.toLowerCase()&&event.args.to.toLowerCase()===requirements.payTo.toLowerCase()&&event.args.value===BigInt(requirements.amount);}catch{return false;}
    });
    const authorizations=mined.logs.filter(log=>{
      if(log.address.toLowerCase()!==requirements.asset.toLowerCase())return false;
      try{const event=decodeEventLog({abi:authorizationAbi,data:log.data,topics:log.topics});return event.args.authorizer.toLowerCase()===auth.from!.toLowerCase()&&event.args.nonce.toLowerCase()===auth.nonce!.toLowerCase();}catch{return false;}
    });
    return matches.length===1&&authorizations.length===1;
  };
}

/** Locate an original EIP-3009 settlement even when facilitator lost its tx response. */
export function evmSettlementRecovery(rpcUrls:Readonly<Record<string,string>>) {
  const clientFor=async(requirements:PaymentRequirements)=>{
    const rpc=rpcUrls[requirements.network];
    if(!rpc)throw new CommerceError('rpc_missing','Configure the settlement network RPC');
    validateUrl(rpc,true);
    const client=createPublicClient({transport:http(rpc,{timeout:15000,retryCount:0})});
    if(await client.getChainId()!==Number(requirements.network.split(':')[1]))throw new CommerceError('rpc_network','RPC network does not match frozen requirements');
    return client;
  };
  const expiredUnusedProof=async(payload:PaymentPayload,requirements:PaymentRequirements):Promise<ExpiredUnusedProof|undefined>=>{
    try{
      const asset=officialUsdc[requirements.network];
      if(!asset||typeof requirements.asset!=='string'||requirements.asset.toLowerCase()!==asset)return undefined;
      const auth=(payload.payload as {authorization?:{from?:string;to?:string;value?:string;nonce?:string;validAfter?:string;validBefore?:string}})?.authorization;
      if(!auth||!/^0x[0-9a-fA-F]{40}$/.test(auth.from??'')||!/^0x[0-9a-fA-F]{64}$/.test(auth.nonce??'')||
        auth.to?.toLowerCase()!==requirements.payTo.toLowerCase()||auth.value!==requirements.amount||
        !/^(0|[1-9][0-9]{0,77})$/.test(auth.validAfter??'')||!/^(0|[1-9][0-9]{0,77})$/.test(auth.validBefore??''))return undefined;
      const validAfter=BigInt(auth.validAfter!),validBefore=BigInt(auth.validBefore!);
      if(validAfter>=validBefore||validBefore>=2n**256n)return undefined;
      const client=await clientFor(requirements);
      const finalized=await client.getBlock({blockTag:'finalized'});
      if(finalized.number===null||!/^0x[0-9a-fA-F]{64}$/.test(finalized.hash??'')||
        finalized.timestamp<validBefore||finalized.timestamp<validAfter)return undefined;
      // A missing nonce log is not proof. Read the official token's state at
      // the exact finalized block, after this authorization can no longer execute.
      const used=await client.readContract({address:asset as Hex,abi:authorizationStateAbi,functionName:'authorizationState',
        args:[auth.from as Hex,auth.nonce as Hex],blockNumber:finalized.number});
      if(used!==false)return undefined;
      const canonical=await client.getBlock({blockNumber:finalized.number});
      if(canonical.hash!==finalized.hash||canonical.number!==finalized.number||canonical.timestamp!==finalized.timestamp)return undefined;
      return {expiredUnused:true,network:requirements.network,asset,payer:auth.from!.toLowerCase(),nonce:auth.nonce!.toLowerCase(),
        validAfter:auth.validAfter!,validBefore:auth.validBefore!,blockNumber:finalized.number.toString(),
        blockHash:finalized.hash!,blockTimestamp:finalized.timestamp.toString(),finality:'finalized',authorizationUsed:false};
    }catch{
      // Unsupported finalized tags, archive state gaps, malformed return values
      // and network errors retain the original unknown operation and its budget.
      return undefined;
    }
  };
  return {
    expiredUnusedProof,
    proveExpiredUnused:async(payload:PaymentPayload,requirements:PaymentRequirements):Promise<boolean>=>!!await expiredUnusedProof(payload,requirements),
    checkpoint:async(requirements:PaymentRequirements):Promise<string>=>{
      const client=await clientFor(requirements);const block=await client.getBlockNumber();
      return (block>12n?block-12n:0n).toString();
    },
    findOriginalReceipt:async(payload:PaymentPayload,requirements:PaymentRequirements,fromBlock:string):Promise<SettleResponse|undefined>=>{
      if(!/^(0|[1-9][0-9]*)$/.test(fromBlock))throw new CommerceError('recovery_checkpoint','Invalid original chain checkpoint');
      const auth=(payload.payload as {authorization?:{from?:string;nonce?:string}}).authorization;
      if(!/^0x[0-9a-fA-F]{40}$/.test(auth?.from??'')||!/^0x[0-9a-fA-F]{64}$/.test(auth?.nonce??''))throw new CommerceError('invalid_payment','Missing original EIP-3009 identity');
      const client=await clientFor(requirements);const latest=await client.getBlockNumber();
      // Bounded per reconciliation. Very old operations need an operator/archive
      // RPC lookup; never reinterpret incomplete search as proof of non-payment.
      if(latest-BigInt(fromBlock)>100000n)throw new CommerceError('archive_reconciliation_required','Original authorization requires an archive log lookup');
      // The default public Base RPCs limit eth_getLogs to 200-block ranges.
      for(let start=BigInt(fromBlock);start<=latest;start+=200n){
        const end=start+199n<latest?start+199n:latest;
        const logs=await client.getLogs({address:requirements.asset as Hex,event:authorizationAbi[0],args:{authorizer:auth!.from as Hex,nonce:auth!.nonce as Hex},fromBlock:start,toBlock:end,strict:true});
        const settled=logs.filter(log=>!log.removed&&log.transactionHash);
        if(settled.length>1)throw new CommerceError('ambiguous_receipt','Multiple authorization events require manual reconciliation');
        if(settled.length===1)return {success:true,transaction:settled[0]!.transactionHash,network:requirements.network,payer:auth!.from!};
      }
      return undefined;
    },
  };
}
