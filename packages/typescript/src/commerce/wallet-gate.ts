import { createHash } from 'node:crypto';
import { Challenge, Credential, Method, Receipt } from 'mppx';
import { Mppx } from 'mppx/server/core';
import { digest } from './config.js';
import { CommerceError } from './types.js';
import { CommerceStore, type OrderRecord } from './store.js';
import { CredentialVault } from './vault.js';
import type { GateResult } from './x402.js';
import { assertWalletCredential, envarMethod, EnvarMerchantClient, walletChallengeWire, type WalletPayment } from './wallet-client.js';

export interface WalletGateOptions {
  store: CommerceStore; vault: CredentialVault; origin: string; hmacSecret: string;
  client: EnvarMerchantClient;
}
interface SavedWalletAuthorization { method:'envar'; issuer:string; environment:string; challenge:Challenge.Challenge; credential:string; }

/** MPP charge gate. Central capture is authoritative; the local transaction creates one Task/outbox. */
export class EnvarWalletGate {
  private timer?: ReturnType<typeof setInterval>;
  private flushing?: Promise<void>;
  constructor(private readonly options:WalletGateOptions) {
    if(Buffer.byteLength(options.hmacSecret)<32)throw new CommerceError('wallet_hmac_key','A private 32-byte challenge key is required');
  }
  start():void {
    if(this.timer)return;
    this.timer=setInterval(()=>{void this.flushCompletions().catch(()=>undefined);},2000);this.timer.unref();
  }
  async stop():Promise<void> {if(this.timer)clearInterval(this.timer);this.timer=undefined;await this.flushing;}
  async flushCompletions():Promise<void> {
    if(this.flushing)return this.flushing;
    this.flushing=(async()=>{
      for(const row of this.options.store.walletCompletions()){
        if(row.issuer!==this.options.client.issuer||row.environment!==this.options.client.environment||row.recipient!==this.options.client.merchant)continue;
        await this.options.client.complete(row.reference);
        this.options.store.completeWalletNotification(row.orderId);
      }
    })().finally(()=>{this.flushing=undefined;});
    return this.flushing;
  }
  private assertProfile(order:OrderRecord):void {
    const profile=order.quote.paymentProfile,client=this.options.client;
    if(profile?.adapter!=='mpp'||profile.method!=='envar'||profile.issuer!==client.issuer||profile.environment!==client.environment||profile.merchantId!==client.merchant||order.quote.recipient!==client.merchant)throw new CommerceError('wallet_profile','Wallet merchant configuration differs from the frozen offer');
  }
  private async verify(order:OrderRecord,challenge:Challenge.Challenge,payment:WalletPayment):Promise<GateResult> {
    if(payment.amount!==order.quote.amount||payment.recipient!==order.quote.recipient||payment.challengeId!==challenge.id||payment.bindingDigest!==digest(walletChallengeWire(challenge))||!payment.receipt)throw new CommerceError('wallet_receipt_binding','Original charge differs from the order');
    const attempt=this.options.store.paymentForOrder(order.id);
    if(!attempt)throw new CommerceError('wallet_recovery','Original local authorization is required');
    if(payment.state==='refunded'||payment.state==='partially_refunded'){
      // Preserve capture history and prevent any new dispatch after a central refund.
      if(attempt.state!=='confirmed')this.options.store.recordSettlement(attempt.id,'confirmed',payment.receipt);
      this.options.store.blockWalletDispatch(order.id,order.caller,true);
      throw new CommerceError('wallet_refunded','This payment was refunded; read the original Task instead');
    }
    if(payment.state!=='captured')throw new CommerceError('wallet_payment_pending','The original wallet charge is not captured');
    this.options.store.recordSettlement(attempt.id,'confirmed',payment.receipt);
    return {headers:{'Payment-Receipt':Receipt.serialize(payment.receipt)}};
  }
  async recover(orderId:string,caller:string):Promise<{state:string;taskId:string}> {
    const order=this.options.store.getOrder(orderId,caller);
    if(!order)throw new CommerceError('order_not_found','Original order not found');
    this.assertProfile(order);
    const attempt=this.options.store.paymentForOrder(order.id),challenge=this.options.store.paymentChallenge<Challenge.Challenge>(order.id);
    if(!attempt||!challenge)throw new CommerceError('wallet_recovery','No original wallet authorization');
    const payment=await this.options.client.lookup(challenge);
    if(payment?.receipt){await this.verify(order,challenge,payment);return {state:'confirmed',taskId:order.taskId};}
    if(payment&&['voided','expired'].includes(payment.state)){
      this.options.store.recordSettlement(attempt.id,'rejected',{});return {state:'rejected',taskId:order.taskId};
    }
    // Read-only recovery never issues a replacement payment or executes work on uncertainty.
    return {state:'unknown',taskId:order.taskId};
  }
  async refund(orderId:string,caller:string,amount:string,reason:string,key:string):Promise<WalletPayment> {
    const order=this.options.store.getOrder(orderId,caller);
    if(!order)throw new CommerceError('order_not_found','Original order not found');
    this.assertProfile(order);
    const receipt=this.options.store.paymentForOrder(order.id)?.receipt;
    if(typeof receipt?.reference!=='string')throw new CommerceError('wallet_recovery','Recover the original captured charge');
    this.options.store.blockWalletDispatch(orderId,caller);
    return this.options.client.refund(receipt.reference,amount,reason,key);
  }
  async handle(request:Request,order:OrderRecord):Promise<GateResult> {
    this.assertProfile(order);
    if(this.options.store.walletBlocked(order.id))throw new CommerceError('wallet_refunded','This order no longer permits new execution');
    const body=await request.clone().text(),bodyDigest=`sha-256=:${createHash('sha256').update(body).digest('base64')}:`;
    let challenge=this.options.store.paymentChallenge<Challenge.Challenge>(order.id);
    if(!challenge){
      challenge=this.options.store.freezePaymentChallenge(order.id,Challenge.from({
        secretKey:this.options.hmacSecret,realm:new URL(this.options.origin).host,method:'envar',intent:'charge',
        request:{amount:order.quote.amount,currency:'cny',recipient:this.options.client.merchant,externalId:order.quote.quoteId,methodDetails:{version:'1',issuer:this.options.client.issuer}},
        expires:new Date(order.quote.expiresAt),header:'Payment-Authorization',digest:bodyDigest,
        meta:{endpoint:request.url,callerBinding:order.caller,serviceRef:new URL(`/services/${encodeURIComponent(order.quote.serviceId)}`,this.options.origin).href,serviceRevision:String(order.quote.serviceRevision),termsDigest:order.quote.termsDigest,messageId:order.messageId},
      }));
    }
    if(challenge.digest!==bodyDigest)throw new CommerceError('wallet_request_binding','Use the exact original request bytes');
    const prior=this.options.store.paymentForOrder(order.id);
    if(prior){
      const payment=await this.options.client.lookup(challenge);
      if(payment?.receipt)return this.verify(order,challenge,payment);
      if(prior.state==='rejected'||payment&&['voided','expired'].includes(payment.state))throw new CommerceError('wallet_payment_inactive','The original payment is no longer active');
    }
    if(Date.now()>=Date.parse(order.quote.expiresAt))throw new CommerceError('quote_expired','The original unpaid quote expired');
    await this.options.client.register(challenge);
    const unpaid=(code?:string):GateResult=>({response:Response.json({type:'about:blank',title:code??'Payment Required',status:402},{status:402,headers:{'Cache-Control':'no-store','WWW-Authenticate':Challenge.serialize(challenge!)}})});
    const header=request.headers.get('Payment-Authorization');
    if(!header)return unpaid();
    if(header.length>32768)return unpaid('invalid_payment');
    let token:string;
    try {token=assertWalletCredential(header,challenge);if(!Challenge.verify(challenge,{secretKey:this.options.hmacSecret}))return unpaid('invalid_payment');}
    catch{return unpaid('invalid_payment');}
    let attemptId=prior?.id;
    if(!attemptId){
      const ref=this.options.vault.put({method:'envar',issuer:this.options.client.issuer,environment:this.options.client.environment,challenge,credential:header} satisfies SavedWalletAuthorization);
      attemptId=this.options.store.reservePayment(order.id,order.caller,digest({method:'envar',issuer:this.options.client.issuer,token}),ref);
    }else{
      const saved=this.options.vault.get(prior!.credentialRef) as SavedWalletAuthorization;
      if(saved.method!=='envar'||saved.credential!==header||saved.issuer!==this.options.client.issuer||saved.environment!==this.options.client.environment)throw new CommerceError('wallet_recovery_binding','Use the original payment credential');
    }
    const runtime=Mppx.create({secretKey:this.options.hmacSecret,realm:challenge.realm,requiresAuth:true,methods:[Method.toServer(envarMethod,{
      verify:async()=>{
        const payment=await this.options.client.redeem(token,challenge!,order.caller,request.url);
        if(!payment.receipt||payment.state!=='captured')throw new CommerceError('wallet_payment_pending','Wallet capture is not confirmed');
        return payment.receipt;
      },
    })]});
    try {
      await runtime.broadcastCredential(Credential.deserialize(header),{realm:challenge.realm,request:challenge.request,meta:JSON.parse(Buffer.from(challenge.opaque!,'base64url').toString('utf8'))});
    }catch{
      if(this.options.store.paymentForOrder(order.id)?.state==='settling')this.options.store.recordSettlement(attemptId,'unknown',{});
    }
    const payment=await this.options.client.lookup(challenge);
    if(payment?.receipt)return this.verify(order,challenge,payment);
    return {response:Response.json({error:'wallet_reconciliation_required'},{status:503,headers:{'Cache-Control':'no-store'}})};
  }
}
