import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Task, TaskState, type ListTasksRequest, type ListTasksResponse } from '@a2a-js/sdk';
import type { TaskStore, ServerCallContext } from '@a2a-js/sdk/server';
import { CommerceError, type CommerceConfig, type Input, type PriceQuote, type Service } from './types.js';
import { digest } from './config.js';

export interface OrderRecord {
  id: string; caller: string; serviceRevision: string; offerId: string;
  messageId: string; inputDigest: string; input: Input; quote: PriceQuote; taskId: string;
  paymentState: 'not_required' | 'quoted' | 'settling' | 'confirmed' | 'rejected' | 'unknown';
  executionState: 'not_started' | 'queued' | 'dispatching' | 'working' | 'completed' | 'failed' | 'unknown';
}
type Row = Record<string, string | number | null>;

/** A single-process SQLite store. Every quote/purchase key is scoped to caller. */
export class CommerceStore implements TaskStore {
  private readonly db: DatabaseSync;
  private readonly ownerDb?:DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') { mkdirSync(dirname(path), {recursive:true,mode:0o700}); }
    if(path!==':memory:'){
      // Separate SQLite ownership transaction survives no process: OS file locks
      // are released on SIGKILL, so restart does not need unsafe stale-file unlink.
      this.ownerDb=new DatabaseSync(path+'.owner.sqlite3');
      chmodSync(path+'.owner.sqlite3',0o600);
      try {this.ownerDb.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');}
      catch {this.ownerDb.close();throw new CommerceError('store_locked','This ledger has an active owner lock. Stop its process before starting another instance.');}
    }
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path,0o600);
    this.db.exec(`
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS commerce_meta (version INTEGER NOT NULL);
      INSERT INTO commerce_meta SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM commerce_meta);
      CREATE TABLE IF NOT EXISTS commerce_service_revisions (id TEXT PRIMARY KEY, digest TEXT NOT NULL, service_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS commerce_orders (
        id TEXT PRIMARY KEY, caller TEXT NOT NULL, service_revision TEXT NOT NULL,
        offer_id TEXT NOT NULL, message_id TEXT NOT NULL, input_digest TEXT NOT NULL,
        input_json TEXT NOT NULL, quote_json TEXT NOT NULL, task_id TEXT NOT NULL UNIQUE,
        payment_state TEXT NOT NULL CHECK(payment_state IN ('not_required','quoted','settling','confirmed','rejected','unknown')),
        execution_state TEXT NOT NULL CHECK(execution_state IN ('not_started','queued','dispatching','working','completed','failed','unknown')),
        UNIQUE(caller,service_revision,message_id)
      );
      CREATE TABLE IF NOT EXISTS commerce_tasks (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, tenant TEXT NOT NULL,
        task_json TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS commerce_outbox (
        order_id TEXT PRIMARY KEY REFERENCES commerce_orders(id),
        state TEXT NOT NULL CHECK(state IN ('ready','dispatching','done','unknown')),
        remote_origin TEXT, remote_task_id TEXT
      );
      CREATE TABLE IF NOT EXISTS commerce_payment_attempts (
        id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES commerce_orders(id),
        economic_key TEXT NOT NULL UNIQUE, credential_ref TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('settling','confirmed','rejected','unknown')),
        receipt_json TEXT
      );
      CREATE TABLE IF NOT EXISTS commerce_payment_challenges (
        order_id TEXT PRIMARY KEY REFERENCES commerce_orders(id), challenge_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS commerce_payment_identifiers (
        caller TEXT NOT NULL, identifier TEXT NOT NULL,
        attempt_id TEXT NOT NULL UNIQUE REFERENCES commerce_payment_attempts(id),
        PRIMARY KEY(caller,identifier)
      );
      CREATE TRIGGER IF NOT EXISTS require_paid_outbox BEFORE INSERT ON commerce_outbox
      WHEN NOT EXISTS (SELECT 1 FROM commerce_orders WHERE id=NEW.order_id AND payment_state IN ('confirmed','not_required'))
      BEGIN SELECT RAISE(ABORT,'Payment not confirmed'); END;
    `);
    const v = this.db.prepare('SELECT version FROM commerce_meta').get() as Row;
    if (v.version !== 1) { this.db.close(); throw new CommerceError('store_version','Unsupported commerce store version'); }
  }
  close(): void {
    this.db.close();
    if(this.ownerDb){this.ownerDb.exec('ROLLBACK');this.ownerDb.close();}
  }
  registerCatalog(config:CommerceConfig):void {
    this.transaction(()=>{
      for(const service of config.services){
        const id=`${service.id}:${service.revision}`;
        const snapshot={service,profiles:Object.fromEntries(service.offers.filter(x=>x.paymentProfile).map(x=>[x.paymentProfile!,config.paymentProfiles[x.paymentProfile!]]))};
        const fingerprint=digest(snapshot);
        const prior=this.db.prepare('SELECT digest FROM commerce_service_revisions WHERE id=?').get(id) as Row|undefined;
        if(prior&&prior.digest!==fingerprint)throw new CommerceError('immutable_revision','Changing a service or payment profile requires a new service revision');
        this.db.prepare('INSERT OR IGNORE INTO commerce_service_revisions VALUES (?,?,?)').run(id,fingerprint,JSON.stringify(snapshot));
      }
    });
  }
  serviceRevision(id:string):Service|undefined {
    const row=this.db.prepare('SELECT service_json FROM commerce_service_revisions WHERE id=?').get(id) as Row|undefined;
    return row?JSON.parse(String(row.service_json)).service:undefined;
  }
  catalogHistory():{service:Service;profiles:CommerceConfig['paymentProfiles']}[] {
    return (this.db.prepare('SELECT service_json FROM commerce_service_revisions ORDER BY rowid').all() as Row[]).map(r=>JSON.parse(String(r.service_json)));
  }
  private transaction<T>(fn:()=>T):T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result=fn(); this.db.exec('COMMIT'); return result; }
    catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  private order(row: Row | undefined): OrderRecord | undefined {
    return row ? {id:String(row.id),caller:String(row.caller),serviceRevision:String(row.service_revision),offerId:String(row.offer_id),messageId:String(row.message_id),inputDigest:String(row.input_digest),input:JSON.parse(String(row.input_json)),quote:JSON.parse(String(row.quote_json)),taskId:String(row.task_id),paymentState:row.payment_state as OrderRecord['paymentState'],executionState:row.execution_state as OrderRecord['executionState']} : undefined;
  }
  getOrder(id:string,caller:string):OrderRecord|undefined {
    return this.order(this.db.prepare('SELECT * FROM commerce_orders WHERE id=? AND caller=?').get(id,caller) as Row|undefined);
  }
  paymentForOrder(orderId:string):{id:string;state:string;credentialRef:string;receipt:Record<string,unknown>|null}|undefined {
    const row=this.db.prepare('SELECT * FROM commerce_payment_attempts WHERE order_id=? ORDER BY rowid DESC LIMIT 1').get(orderId) as Row|undefined;
    return row?{id:String(row.id),state:String(row.state),credentialRef:String(row.credential_ref),receipt:row.receipt_json?JSON.parse(String(row.receipt_json)):null}:undefined;
  }
  paymentChallenge<T>(orderId:string):T|undefined {
    const row=this.db.prepare('SELECT challenge_json FROM commerce_payment_challenges WHERE order_id=?').get(orderId) as Row|undefined;
    return row?JSON.parse(String(row.challenge_json)):undefined;
  }
  freezePaymentChallenge<T>(orderId:string,challenge:T):T {
    return this.transaction(()=>{
      this.db.prepare('INSERT OR IGNORE INTO commerce_payment_challenges VALUES (?,?)').run(orderId,JSON.stringify(challenge));
      return this.paymentChallenge<T>(orderId)!;
    });
  }
  findOrder(caller:string,serviceRevision:string,messageId:string):OrderRecord|undefined {
    return this.order(this.db.prepare('SELECT * FROM commerce_orders WHERE caller=? AND service_revision=? AND message_id=?').get(caller,serviceRevision,messageId) as Row|undefined);
  }
  ensureQuote(quote:PriceQuote,input:Input):OrderRecord {
    if(digest(input)!==quote.inputDigest)throw new CommerceError('quote_mismatch','Input must match the frozen quote');
    return this.transaction(()=>{
      const version=`${quote.serviceId}:${quote.serviceRevision}`;
      const existing=this.findOrder(quote.caller,version,quote.messageId);
      if(existing){
        if(existing.inputDigest!==quote.inputDigest || existing.offerId!==quote.offerId) throw new CommerceError('purchase_conflict','Message ID already identifies a different purchase');
        return existing;
      }
      const id=randomUUID(), taskId=randomUUID();
      this.db.prepare('INSERT INTO commerce_orders VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id,quote.caller,version,quote.offerId,quote.messageId,quote.inputDigest,JSON.stringify(input),JSON.stringify(quote),taskId,quote.paymentProfile?'quoted':'not_required','not_started');
      return this.getOrder(id,quote.caller)!;
    });
  }
  private createTaskOnce(order:OrderRecord):Task {
    let row=this.db.prepare('SELECT task_json FROM commerce_tasks WHERE id=?').get(order.taskId) as Row|undefined;
    if(!row){
      const task=Task.fromJSON({id:order.taskId,contextId:randomUUID(),status:{state:'TASK_STATE_SUBMITTED',timestamp:new Date().toISOString()}});
      this.db.prepare('INSERT INTO commerce_tasks VALUES (?,?,?,?,?)').run(task.id,order.caller,order.serviceRevision,JSON.stringify(Task.toJSON(task)),new Date().toISOString());
      row={task_json:JSON.stringify(Task.toJSON(task))};
    }
    this.db.prepare("INSERT OR IGNORE INTO commerce_outbox(order_id,state) VALUES (?,'ready')").run(order.id);
    this.db.prepare("UPDATE commerce_orders SET execution_state='queued' WHERE id=? AND execution_state='not_started'").run(order.id);
    return Task.fromJSON(JSON.parse(String(row.task_json)));
  }
  enqueueFree(orderId:string,caller:string):Task {
    return this.transaction(()=>{
      const order=this.getOrder(orderId,caller);
      if(!order || order.paymentState!=='not_required') throw new CommerceError('payment_required','Free execution requires a free order');
      return this.createTaskOnce(order);
    });
  }
  reservePayment(orderId:string,caller:string,economicKey:string,credentialRef:string,paymentIdentifier?:string):string {
    return this.transaction(()=>{
      const order=this.getOrder(orderId,caller);
      if(!order || !['quoted','rejected'].includes(order.paymentState)) throw new CommerceError('payment_recovery_required','Inspect the original payment before authorizing another');
      if(Date.now()>=Date.parse(order.quote.expiresAt)) throw new CommerceError('quote_expired','Review a new quote');
      if(!economicKey || !credentialRef) throw new CommerceError('invalid_payment','Original payment identity and credential reference required');
      if(this.db.prepare('SELECT id FROM commerce_payment_attempts WHERE economic_key=?').get(economicKey))throw new CommerceError('payment_reuse','Economic payment is already bound to an order');
      const id=randomUUID();
      this.db.prepare("INSERT INTO commerce_payment_attempts(id,order_id,economic_key,credential_ref,state) VALUES (?,?,?,?,'settling')").run(id,orderId,economicKey,credentialRef);
      if(paymentIdentifier){
        if(this.db.prepare('SELECT attempt_id FROM commerce_payment_identifiers WHERE caller=? AND identifier=?').get(caller,paymentIdentifier))throw new CommerceError('identifier_reuse','Payment identifier already belongs to another attempt');
        this.db.prepare('INSERT INTO commerce_payment_identifiers VALUES (?,?,?)').run(caller,paymentIdentifier,id);
      }
      this.db.prepare("UPDATE commerce_orders SET payment_state='settling' WHERE id=?").run(orderId);
      return id;
    });
  }
  recordSettlement(attemptId:string,state:'confirmed'|'rejected'|'unknown',receipt:Record<string,unknown>):Task|undefined {
    return this.transaction(()=>{
      const attempt=this.db.prepare('SELECT * FROM commerce_payment_attempts WHERE id=?').get(attemptId) as Row|undefined;
      if(!attempt)throw new CommerceError('attempt_not_found','Original payment attempt not found');
      if(attempt.state==='confirmed' && state!=='confirmed')throw new CommerceError('settlement_conflict','Confirmed payment cannot become unpaid');
      if(attempt.state==='rejected' && state!=='rejected')throw new CommerceError('settlement_conflict','Definitive rejection cannot be changed to another outcome');
      this.db.prepare('UPDATE commerce_payment_attempts SET state=?,receipt_json=? WHERE id=?').run(state,JSON.stringify(receipt),attemptId);
      this.db.prepare('UPDATE commerce_orders SET payment_state=? WHERE id=?').run(state,String(attempt.order_id));
      const order=this.order(this.db.prepare('SELECT * FROM commerce_orders WHERE id=?').get(String(attempt.order_id)) as Row)!;
      return state==='confirmed'?this.createTaskOnce(order):undefined;
    });
  }
  claimReady():OrderRecord|undefined {
    return this.transaction(()=>{
      const row=this.db.prepare("SELECT o.* FROM commerce_orders o JOIN commerce_outbox x ON x.order_id=o.id WHERE x.state='ready' ORDER BY o.rowid LIMIT 1").get() as Row|undefined;
      if(!row)return undefined;
      this.db.prepare("UPDATE commerce_outbox SET state='dispatching' WHERE order_id=?").run(String(row.id));
      this.db.prepare("UPDATE commerce_orders SET execution_state='dispatching' WHERE id=?").run(String(row.id));
      return this.order({...row,execution_state:'dispatching'});
    });
  }
  markExecutionUnknown(orderId:string):void {
    this.transaction(()=>{
      this.db.prepare("UPDATE commerce_orders SET execution_state='unknown' WHERE id=? AND execution_state NOT IN ('completed','failed')").run(orderId);
      this.db.prepare("UPDATE commerce_outbox SET state='unknown' WHERE order_id=? AND state!='done'").run(orderId);
      this.markTaskUnknown(orderId);
    });
  }
  private markTaskUnknown(orderId:string):void {
    const row=this.db.prepare('SELECT t.task_json FROM commerce_tasks t JOIN commerce_orders o ON o.task_id=t.id WHERE o.id=?').get(orderId) as Row|undefined;
    if(!row)return;
    const task=Task.fromJSON(JSON.parse(String(row.task_json)));
    task.status={state:TaskState.TASK_STATE_UNSPECIFIED,timestamp:new Date().toISOString(),message:undefined};
    task.metadata={...task.metadata,executionState:'unknown',recoveryRequired:true};
    this.db.prepare('UPDATE commerce_tasks SET task_json=?,updated_at=? WHERE id=?').run(JSON.stringify(Task.toJSON(task)),new Date().toISOString(),task.id);
  }
  recordRemoteTask(orderId:string,origin:string,remoteTaskId:string):void {
    if(!origin||!remoteTaskId)throw new CommerceError('invalid_remote_task','Remote origin and task ID required');
    this.transaction(()=>{
      const row=this.db.prepare('SELECT remote_origin,remote_task_id FROM commerce_outbox WHERE order_id=?').get(orderId) as Row|undefined;
      if(!row)throw new CommerceError('order_not_found','Order not dispatched');
      if(row.remote_task_id && (row.remote_task_id!==remoteTaskId||row.remote_origin!==origin))throw new CommerceError('remote_task_conflict','Cannot replace original remote task');
      this.db.prepare('UPDATE commerce_outbox SET remote_origin=?,remote_task_id=? WHERE order_id=?').run(origin,remoteTaskId,orderId);
      this.db.prepare("UPDATE commerce_orders SET execution_state='working' WHERE id=?").run(orderId);
    });
  }
  recoverInterruptedDispatches():number {
    return this.transaction(()=>{
      const pending=this.db.prepare("SELECT order_id FROM commerce_outbox WHERE state='dispatching'").all() as Row[];
      const result=this.db.prepare("UPDATE commerce_orders SET execution_state='unknown' WHERE id IN (SELECT order_id FROM commerce_outbox WHERE state='dispatching')").run();
      this.db.prepare("UPDATE commerce_outbox SET state='unknown' WHERE state='dispatching'").run();
      for(const row of pending)this.markTaskUnknown(String(row.order_id));
      return Number(result.changes);
    });
  }
  private scope(context:ServerCallContext):{owner:string;tenant:string} {
    if(!context.user?.isAuthenticated || !context.user.userName)throw new CommerceError('authentication_required','Authenticated task owner required');
    return {owner:context.user.userName,tenant:context.tenant??''};
  }
  async save(task:Task,context:ServerCallContext):Promise<void> {
    const scope=this.scope(context);
    this.transaction(()=>{
      const current=this.db.prepare('SELECT owner,tenant FROM commerce_tasks WHERE id=?').get(task.id) as Row|undefined;
      if(current&&(current.owner!==scope.owner||current.tenant!==scope.tenant))throw new CommerceError('task_owner_conflict','Cannot replace another owner task');
      const order=this.db.prepare('SELECT payment_state FROM commerce_orders WHERE task_id=?').get(task.id) as Row|undefined;
      if(order&&!['confirmed','not_required'].includes(String(order.payment_state)))throw new CommerceError('payment_required','Cannot publish task execution before payment');
      const serialized=JSON.stringify(Task.toJSON(task));
      if(Buffer.byteLength(serialized)>4*1024*1024)throw new CommerceError('task_too_large','Task snapshot exceeds 4 MiB');
      this.db.prepare('INSERT INTO commerce_tasks VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET task_json=excluded.task_json,updated_at=excluded.updated_at').run(task.id,scope.owner,scope.tenant,serialized,new Date().toISOString());
      const terminal=[TaskState.TASK_STATE_COMPLETED,TaskState.TASK_STATE_FAILED,TaskState.TASK_STATE_CANCELED,TaskState.TASK_STATE_REJECTED].includes(task.status?.state??0);
      if(terminal){
        this.db.prepare('UPDATE commerce_orders SET execution_state=? WHERE task_id=? AND caller=?').run(task.status?.state===TaskState.TASK_STATE_COMPLETED?'completed':'failed',task.id,scope.owner);
        this.db.prepare("UPDATE commerce_outbox SET state='done' WHERE order_id IN (SELECT id FROM commerce_orders WHERE task_id=? AND caller=?)").run(task.id,scope.owner);
      }
    });
  }
  async load(taskId:string,context:ServerCallContext):Promise<Task|undefined> {
    const scope=this.scope(context);const row=this.db.prepare('SELECT task_json FROM commerce_tasks WHERE id=? AND owner=? AND tenant=?').get(taskId,scope.owner,scope.tenant) as Row|undefined;
    return row?Task.fromJSON(JSON.parse(String(row.task_json))):undefined;
  }
  async list(params:ListTasksRequest,context:ServerCallContext):Promise<ListTasksResponse> {
    const scope=this.scope(context);const pageSize=params.pageSize||50;
    if(pageSize<1||pageSize>100||!/^\d*$/.test(params.pageToken)|| (params.historyLength!==undefined&&params.historyLength<0))throw new CommerceError('invalid_page','Invalid task pagination');
    const offset=Number(params.pageToken||'0');
    if(!Number.isSafeInteger(offset))throw new CommerceError('invalid_page','Invalid task offset');
    const all=(this.db.prepare('SELECT task_json FROM commerce_tasks WHERE owner=? AND tenant=? ORDER BY updated_at DESC,id').all(scope.owner,scope.tenant) as Row[])
      .map(r=>Task.fromJSON(JSON.parse(String(r.task_json))))
      .filter(t=>(!params.contextId||t.contextId===params.contextId)&&(!params.status||t.status?.state===params.status)&&(!params.statusTimestampAfter||Date.parse(t.status?.timestamp??'')>=Date.parse(params.statusTimestampAfter)));
    const tasks=all.slice(offset,offset+pageSize).map(t=>({...t,artifacts:params.includeArtifacts?t.artifacts:[],history:params.historyLength===undefined?t.history:params.historyLength===0?[]:t.history.slice(-params.historyLength)}));
    return {tasks,nextPageToken:offset+pageSize<all.length?String(offset+pageSize):'',pageSize,totalSize:all.length};
  }
  fingerprint(order:OrderRecord):string { return digest({caller:order.caller,serviceRevision:order.serviceRevision,offerId:order.offerId,messageId:order.messageId,inputDigest:order.inputDigest}); }
}
