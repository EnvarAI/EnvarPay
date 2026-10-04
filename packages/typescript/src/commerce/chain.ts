import {createPublicClient,http,decodeEventLog,parseAbi,type Hex} from 'viem';
import type {PaymentPayload,PaymentRequirements,SettleResponse} from '@x402/core/types';
import {CommerceError} from './types.js';
import {validateUrl} from './config.js';

const abi=parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)']);
const authorizationAbi=parseAbi(['event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)']);

/** Checks the canonical chain receipt and exact official-token Transfer. */
export function evmReceiptVerifier(rpcUrls:Readonly<Record<string,string>>,confirmations=2){
  if(!Number.isInteger(confirmations)||confirmations<1)throw new CommerceError('confirmation_policy','Positive confirmation depth required');
  return async(receipt:SettleResponse,payload:PaymentPayload,requirements:PaymentRequirements):Promise<boolean>=>{
    const rpc=rpcUrls[requirements.network];if(!rpc)throw new CommerceError('rpc_missing','Configure the settlement network RPC');
    validateUrl(rpc,true);
    const chainId=Number(requirements.network.split(':')[1]);
    if(!Number.isSafeInteger(chainId)||!/^0x[0-9a-fA-F]{64}$/.test(receipt.transaction)||receipt.network!==requirements.network)return false;
    const client=createPublicClient({transport:http(rpc,{timeout:15000,retryCount:0})});
    if(await client.getChainId()!==chainId)return false;
    const mined=await client.getTransactionReceipt({hash:receipt.transaction as Hex});
    if(mined.status!=='success')return false;
    const block=await client.getBlock({blockNumber:mined.blockNumber});
    if(block.hash!==mined.blockHash)return false;
    const latest=await client.getBlockNumber();if(latest-mined.blockNumber+1n<BigInt(confirmations))return false;
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
  return {
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
      for(let start=BigInt(fromBlock);start<=latest;start+=2000n){
        const end=start+1999n<latest?start+1999n:latest;
        const logs=await client.getLogs({address:requirements.asset as Hex,event:authorizationAbi[0],args:{authorizer:auth!.from as Hex,nonce:auth!.nonce as Hex},fromBlock:start,toBlock:end,strict:true});
        const settled=logs.filter(log=>!log.removed&&log.transactionHash);
        if(settled.length>1)throw new CommerceError('ambiguous_receipt','Multiple authorization events require manual reconciliation');
        if(settled.length===1)return {success:true,transaction:settled[0]!.transactionHash,network:requirements.network,payer:auth!.from!};
      }
      return undefined;
    },
  };
}
