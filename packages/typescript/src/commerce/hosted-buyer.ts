import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import pg from 'pg';
import { CommerceBuyer, type BuyerPreviewInput, type BuyerSnapshot } from './buyer.js';
import { BuyerStore, type PrivateWalletBuyerState } from './buyer-store.js';
import { CommerceError, isEnvarPeer, type BuyerPolicy } from './types.js';
import { EnvarWalletClient, type WalletEnvironment } from './wallet-client.js';
import { MemoryCredentialVault, openHosted, sealHosted, validateHostedKeys, type HostedKey } from './hosted-crypto.js';
import { hostedSellerFetch } from './hosted-network.js';

interface HostedContext {
  version:1; owner:string; policy:BuyerPolicy; preview:BuyerPreviewInput;
  wallet:{issuer:string;environment:WalletEnvironment;principal:string;credential:string};
}
interface HostedState {version:1;buyer:PrivateWalletBuyerState;vault:Record<string,unknown>;}
interface OperationRow {
  id:string;owner_account_id:string;context_ciphertext:Buffer;state_ciphertext:Buffer;
  version:string;lease:string;confirmed_at:Date|null;
}
export interface HostedBuyerOptions {
  databaseUrl:string;stateKey:HostedKey;walletIssuer:string;environment:WalletEnvironment;
  maxConcurrent?:number;
  /** Operator-fixed private route for the public issuer; never supplied by purchase input. */
  walletTransportOrigin?:string;
  /** Optional test adapter; production uses DNS-pinned public seller requests. */
  sellerFetch?:typeof fetch;
  walletFetch?:typeof fetch;
}
const identifier=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
type Action='preview'|'confirm'|'get'|'recover'|'continue';

/** PG is the durable authority; memory SQLite is only the existing SDK's per-invocation projection. */
export class HostedWalletBuyer {
  readonly pool:pg.Pool;
  private readonly sellerFetch:typeof fetch;
  private active=0;
  private draining=false;
  private failures=0;
  private completed=0;
  private readonly capacity:number;
  private readonly walletFetch:typeof fetch;
  constructor(private readonly options:HostedBuyerOptions) {
    validateHostedKeys(options.stateKey);
    this.capacity=options.maxConcurrent??8;
    if(!Number.isInteger(this.capacity)||this.capacity<1||this.capacity>64||!options.walletIssuer||!['sandbox','live'].includes(options.environment))throw new CommerceError('hosted_configuration','Configure bounded concurrency, state keys and wallet environment');
    if(options.environment==='live'){
      const database=new URL(options.databaseUrl);
      if(Buffer.isBuffer(options.stateKey)||database.searchParams.get('sslmode')!=='verify-full'||!database.searchParams.get('sslrootcert'))throw new CommerceError('hosted_configuration','Live buyers require versioned keys and verified PostgreSQL TLS');
    }
    this.pool=new pg.Pool({connectionString:options.databaseUrl,max:8,connectionTimeoutMillis:10000,idleTimeoutMillis:10000});
    this.sellerFetch=options.sellerFetch??hostedSellerFetch(options.environment==='sandbox');
    this.walletFetch=options.walletFetch??fetch;
    if(options.walletTransportOrigin){
      const destination=new URL(options.walletTransportOrigin),issuer=new URL(options.walletIssuer).origin;
      if(destination.protocol!=='http:'||!/^envarai-wallet\.[a-z0-9-]+\.svc\.cluster\.local$/.test(destination.hostname)||
        destination.port!=='8000'||destination.pathname!=='/'||destination.search||destination.hash||destination.username||destination.password)
        throw new CommerceError('hosted_configuration','Configure the fixed wallet service origin');
      this.walletFetch=async(input,init)=>{
        const request=new Request(input,init),url=new URL(request.url);
        if(url.origin!==issuer||!/^\/api\/v1\/wallets?\//.test(url.pathname))throw new CommerceError('hosted_issuer','Wallet request does not belong to the pinned issuer');
        return fetch(new Request(destination.origin+url.pathname+url.search,request));
      };
    }
  }
  beginDrain():void{this.draining=true;}
  async close():Promise<void>{this.beginDrain();await this.pool.end();}
  metrics():string{return `envarai_hosted_active ${this.active}\nenvarai_hosted_completed_total ${this.completed}\nenvarai_hosted_failures_total ${this.failures}\nenvarai_hosted_draining ${Number(this.draining)}\n`;}
  async ready():Promise<boolean>{
    if(this.draining)return false;
    try{
      const check=await this.pool.query(`SELECT
        has_table_privilege(current_user,'commerce_hostedbuyeroperation','SELECT') AS readable,
        has_column_privilege(current_user,'commerce_hostedbuyeroperation','state_ciphertext','UPDATE') AS checkpoint,
        has_column_privilege(current_user,'commerce_hostedbuyeroperation','confirmed_at','UPDATE') AS approval,
        has_table_privilege(current_user,'wallet_entry','INSERT') AS funds`);
      const row=check.rows[0];return !!row?.readable&&!!row?.checkpoint&&!row?.approval&&!row?.funds;
    }catch{return false;}
  }
  private async claim(id:string):Promise<OperationRow>{
    if(!identifier.test(id))throw new CommerceError('hosted_operation','Use an original operation ID');
    const lease=randomUUID();
    const result=await this.pool.query<OperationRow>(`UPDATE commerce_hostedbuyeroperation
      SET lease=$2,lease_until=clock_timestamp()+interval '45 seconds',version=version+1,updated_at=clock_timestamp()
      WHERE id=$1 AND (lease IS NULL OR lease_until<clock_timestamp())
      RETURNING id,owner_account_id,context_ciphertext,state_ciphertext,version,lease,confirmed_at`,[id,lease]);
    if(!result.rowCount)throw new CommerceError('hosted_busy','Original operation is busy or unavailable');
    return result.rows[0]!;
  }
  private async checkpoint(row:OperationRow,state:HostedState):Promise<void>{
    const encrypted=sealHosted(this.options.stateKey,row.id,'state',state);
    const result=await this.pool.query<{version:string}>(`UPDATE commerce_hostedbuyeroperation
      SET state_ciphertext=$4,version=version+1,lease_until=clock_timestamp()+interval '45 seconds',updated_at=clock_timestamp()
      WHERE id=$1 AND lease=$2 AND version=$3 AND lease_until>clock_timestamp() RETURNING version`,[row.id,row.lease,row.version,encrypted]);
    if(!result.rowCount)throw new CommerceError('hosted_fenced','Original operation changed; read it again');
    row.version=result.rows[0]!.version;
  }
  async run(id:string,action:Action,body:Record<string,unknown>={}):Promise<BuyerSnapshot>{
    if(this.draining||this.active>=this.capacity)throw new CommerceError('hosted_busy','Buyer is draining or at capacity');
    this.active++;
    try{const result=await this.execute(id,action,body);this.completed++;return result;}
    catch(error){this.failures++;throw error;}
    finally{this.active--;}
  }
  private async execute(id:string,action:Action,body:Record<string,unknown>):Promise<BuyerSnapshot>{
    const row=await this.claim(id);
    let store:BuyerStore|undefined,buyer:CommerceBuyer|undefined;
    try {
      const context=openHosted(this.options.stateKey,id,'context',row.context_ciphertext) as HostedContext;
      if(context?.version!==1||context.owner!==row.owner_account_id||context.wallet?.issuer!==this.options.walletIssuer||context.wallet.environment!==this.options.environment||
        context.policy?.peers?.length!==1||!isEnvarPeer(context.policy.peers[0]!)||context.preview?.cardUrl!==context.policy.peers[0]!.cardUrl||!identifier.test(context.preview?.messageId??''))throw new CommerceError('hosted_context','Original buyer context is invalid');
      if(Object.keys(body).some(key=>!(action==='continue'?['messageId','input']:['quoteToken','messageId']).includes(key)))throw new CommerceError('hosted_request','Only the original operation fields are accepted');
      if(action==='confirm'&&body.messageId!==context.preview.messageId)throw new CommerceError('hosted_approval','Confirm the original message');
      if(['confirm','recover','continue'].includes(action)&&!row.confirmed_at)throw new CommerceError('hosted_approval','This purchase has not been approved');
      const state:HostedState=row.state_ciphertext.length?openHosted(this.options.stateKey,id,'state',row.state_ciphertext) as HostedState:{version:1,buyer:{version:1,rows:[]},vault:{}};
      if(state.version!==1)throw new CommerceError('hosted_state','Unsupported checkpoint version');
      store=new BuyerStore(':memory:');store.restoreWalletState(state.buyer,context.owner);
      const prior=state.buyer.rows[0]?.record;
      if(prior&&(prior.messageId!==context.preview.messageId||prior.cardUrl!==context.preview.cardUrl||prior.caller!==context.owner))throw new CommerceError('hosted_state','Checkpoint belongs to another original purchase');
      const vault=new MemoryCredentialVault(state.vault);
      const checkpoint=()=>this.checkpoint(row,{version:1,buyer:store!.exportWalletState(),vault:vault.snapshot()});
      const wallet=new EnvarWalletClient({
        issuer:context.wallet.issuer,environment:context.wallet.environment,principal:context.wallet.principal,credential:context.wallet.credential,
        fetchImpl:async(input,init)=>{await checkpoint();return this.walletFetch(input,init);},
      });
      buyer=new CommerceBuyer({policy:context.policy,store,vault,wallet,peerTokens:{},
        fetchImpl:async(input,init)=>{await checkpoint();return this.sellerFetch(input,init);},
      });
      let result:BuyerSnapshot;
      const current=store.exportWalletState().rows[0]?.record;
      if(action==='preview')result=await buyer.preview(context.owner,context.preview);
      else if(!current)throw new CommerceError('hosted_preview','Recover the original unpaid preview first');
      else if(action==='get')result=await buyer.poll(context.owner,current.id);
      else if(action==='continue')result=await buyer.continue(context.owner,current.id,{messageId:String(body.messageId??''),input:body.input as BuyerPreviewInput['input']});
      else if(current.state==='previewed')result=await buyer.confirm(context.owner,{previewId:current.id,quoteToken:action==='confirm'?String(body.quoteToken??''):current.quoteToken,messageId:current.messageId});
      else result=await buyer.recover(context.owner,current.id);
      await checkpoint();
      return result;
    }finally{
      await buyer?.stop();store?.close();
      await this.pool.query('UPDATE commerce_hostedbuyeroperation SET lease=NULL,lease_until=NULL WHERE id=$1 AND lease=$2',[row.id,row.lease]);
    }
  }
}

export function listenHostedWalletBuyer(buyer:HostedWalletBuyer,options:{token:string;origin:string;host?:string;port:number}){
  const expected=Buffer.from(options.token),host=new URL(options.origin).host;
  if(expected.length<32)throw new CommerceError('hosted_token','A separate strong BFF credential is required');
  const server=createServer(async(req,res)=>{
    const respond=(status:number,value:unknown)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
    if(req.headers.host!==host)return respond(421,{error:{code:'invalid_host'}});
    if(req.url==='/health'&&req.method==='GET')return respond(200,{status:'ok',role:'hosted-wallet-buyer'});
    if(req.url==='/ready'&&req.method==='GET'){const ready=await buyer.ready();return respond(ready?200:503,{status:ready?'ready':'unavailable'});}
    const candidate=Buffer.from(req.headers.authorization?.startsWith('Bearer ')?req.headers.authorization.slice(7):'');
    if(candidate.length!==expected.length||!timingSafeEqual(candidate,expected))return respond(401,{error:{code:'unauthorized'}});
    if(req.url==='/metrics'&&req.method==='GET'){res.writeHead(200,{'Content-Type':'text/plain; version=0.0.4'});res.end(buyer.metrics());return;}
    const route=req.url?.match(/^\/v1\/operations\/([0-9a-f-]{36})\/(preview|confirm|get|recover|continue)$/);
    if(req.method!=='POST'||!route)return respond(404,{error:{code:'not_found'}});
    try {
      const chunks:Buffer[]=[];let size=0;
      for await(const chunk of req){size+=chunk.length;if(size>16384)return respond(413,{error:{code:'request_too_large'}});chunks.push(Buffer.from(chunk));}
      const body=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');
      if(!body||typeof body!=='object'||Array.isArray(body))return respond(400,{error:{code:'invalid_request'}});
      return respond(200,await buyer.run(route[1]!,route[2] as Action,body));
    }catch(error){
      const code=error instanceof CommerceError&&/^[a-z_]{1,80}$/.test(error.code)?error.code:'hosted_unavailable';
      return respond(code==='hosted_busy'?409:503,{error:{code}});
    }
  });
  server.requestTimeout=45000;server.headersTimeout=15000;
  server.listen(options.port,options.host??'127.0.0.1');return server;
}
