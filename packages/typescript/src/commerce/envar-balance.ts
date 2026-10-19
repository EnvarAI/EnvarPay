/** Opt-in seller gate for a captured Envar account-balance claim. No x402 or MPP impersonation. */
import { digest } from './config.js';
import { CommerceError, type PriceQuote } from './types.js';
import { CommerceStore, type OrderRecord } from './store.js';
import { CredentialVault } from './vault.js';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
interface SavedClaim { platformOrderId:string; claimToken:string; quoteId:string; }
export interface BalanceClaimArgs { platformOrderId:string; claimToken:string; taskId:string; quote:PriceQuote; }
export interface EnvarBalanceGateOptions {
  store:CommerceStore;
  vault:CredentialVault;
  claim:(args:BalanceClaimArgs)=>Promise<Record<string,unknown>>;
}

export class EnvarBalanceGate {
  constructor(private readonly options:EnvarBalanceGateOptions){}

  private assertReceipt(order:OrderRecord, platformOrderId:string, receipt:Record<string,unknown>):void {
    const quote=order.quote,profile=quote.paymentProfile;
    if(profile?.adapter!=='envar_balance')throw new CommerceError('balance_profile','Original quote is not an Envar balance offer');
    if(receipt.state!=='captured'||receipt.order_id!==platformOrderId||
      receipt.amount!==quote.amount||receipt.currency!=='usd'||receipt.recipient!==profile?.accountRef||
      receipt.quote_id!==quote.quoteId||receipt.message_id!==quote.messageId||
      receipt.task_id!==order.taskId||
      receipt.service_id!==quote.serviceId||receipt.service_revision!==quote.serviceRevision||
      receipt.offer_id!==quote.offerId||receipt.input_digest!==quote.inputDigest||
      receipt.terms_digest!==quote.termsDigest||
      typeof receipt.economic_id!=='string'||!/^ledger:[0-9a-f-]{36}$/i.test(receipt.economic_id))
      throw new CommerceError('balance_receipt_mismatch','Platform capture differs from the frozen service order');
  }

  private async settle(order:OrderRecord, attemptId:string, saved:SavedClaim):Promise<{response:Response}|{headers:Record<string,string>}> {
    if(saved.quoteId!==order.quote.quoteId)throw new CommerceError('balance_recovery_conflict','Original balance claim belongs to another quote');
    let receipt:Record<string,unknown>;
    try{
      receipt=await this.options.claim({platformOrderId:saved.platformOrderId,claimToken:saved.claimToken,taskId:order.taskId,quote:order.quote});
      this.assertReceipt(order,saved.platformOrderId,receipt);
    }catch{
      this.options.store.recordSettlement(attemptId,'unknown',{});
      return {response:Response.json({error:'balance_claim_unknown',taskId:order.taskId},{status:503,headers:{'Cache-Control':'no-store'}})};
    }
    this.options.store.recordSettlement(attemptId,'confirmed',receipt);
    return {headers:{'ENVAR-BALANCE-RECEIPT':String(receipt.economic_id)}};
  }

  async handle(request:Request,order:OrderRecord):Promise<{response:Response}|{headers:Record<string,string>}> {
    const quote=order.quote,profile=quote.paymentProfile;
    if(profile?.adapter!=='envar_balance'||quote.currency!=='usd'||quote.recipient!==profile.accountRef)
      throw new CommerceError('balance_profile','This offer does not accept Envar account balance');
    const prior=this.options.store.paymentForOrder(order.id);
    if(order.paymentState==='confirmed'&&prior?.receipt)
      return {headers:{'ENVAR-BALANCE-RECEIPT':String(prior.receipt.economic_id)}};
    if(['settling','unknown'].includes(order.paymentState)){
      if(!prior)throw new CommerceError('balance_recovery_conflict','Original balance attempt is missing');
      const saved=this.options.vault.get(prior.credentialRef) as SavedClaim;
      return this.settle(order,prior.id,saved);
    }
    if(Date.now()>=Date.parse(quote.expiresAt))
      return {response:Response.json({error:'quote_expired'},{status:409,headers:{'Cache-Control':'no-store'}})};
    const platformOrderId=request.headers.get('Envar-Balance-Order')??'';
    const claimToken=request.headers.get('Envar-Balance-Claim')??'';
    if(!platformOrderId&&!claimToken)
      return {response:Response.json({error:'envar_balance_required',taskId:order.taskId,quote:{quoteId:quote.quoteId,messageId:quote.messageId,serviceId:quote.serviceId,serviceRevision:quote.serviceRevision,offerId:quote.offerId,inputDigest:quote.inputDigest,termsDigest:quote.termsDigest,amount:quote.amount,currency:quote.currency,recipient:quote.recipient,expiresAt:quote.expiresAt}},{status:402,headers:{'Cache-Control':'no-store'}})};
    if(!UUID.test(platformOrderId)||claimToken.length<32||claimToken.length>4096||/\s/.test(claimToken))
      throw new CommerceError('balance_claim','Use the original bounded platform balance claim');
    const credentialRef=this.options.vault.put({platformOrderId,claimToken,quoteId:quote.quoteId} satisfies SavedClaim);
    const economicKey=digest({adapter:'envar_balance',platformOrderId});
    const attempt=this.options.store.reservePayment(order.id,order.caller,economicKey,credentialRef);
    return this.settle(order,attempt,{platformOrderId,claimToken,quoteId:quote.quoteId});
  }
}
