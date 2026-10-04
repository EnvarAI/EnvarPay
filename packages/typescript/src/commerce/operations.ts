import { DatabaseSync } from 'node:sqlite';
import { lstatSync } from 'node:fs';
import { CommerceError } from './types.js';

/** Local owner-only diagnostics: never opens a signer, vault, provider or network. */
export function inspectLedger(path:string,after=0,limit=100) {
  const stat=lstatSync(path);
  if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||(process.getuid&&stat.uid!==process.getuid()))throw new CommerceError('private_file','Inspect an existing ledger owned only by the current user');
  if(!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||limit>100)throw new CommerceError('inspection_cursor','Use a nonnegative row cursor and a limit from1 to100');
  const db=new DatabaseSync(path,{readOnly:true});
  try{
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000');
    const names=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row=>row.name));
    const role=names.has('buyer_purchases')?'buyer':names.has('commerce_orders')?'seller':null;
    if(!role)throw new CommerceError('store_version','Unrecognized commerce ledger');
    const meta=role==='buyer'?'buyer_meta':'commerce_meta',version=role==='buyer'?1:2;
    if(db.prepare(`SELECT version FROM ${meta}`).get()?.version!==version)throw new CommerceError('store_version','Unsupported commerce ledger version');
    const table=role==='buyer'?'buyer_purchases':'commerce_orders';
    const total=Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n);
    const filter=role==='buyer'?"json_extract(record_json,'$.state') IN ('signing','submitted','unknown') OR json_extract(record_json,'$.paymentState') IN ('reserved','unknown') OR json_extract(record_json,'$.executionState')='unknown'":"payment_state IN ('settling','unknown') OR execution_state IN ('dispatching','unknown')";
    const selected=role==='buyer'?"rowid AS cursor,id,json_extract(record_json,'$.paymentState') AS payment_state,json_extract(record_json,'$.executionState') AS execution_state,json_extract(record_json,'$.task.id') AS task_id":"rowid AS cursor,id,payment_state,execution_state,task_id";
    const rows=db.prepare(`SELECT ${selected} FROM ${table} WHERE rowid>? AND (${filter}) ORDER BY rowid LIMIT ?`).all(after,limit+1);
    const page=rows.slice(0,limit).map(row=>({cursor:Number(row.cursor),id:String(row.id),paymentState:String(row.payment_state),executionState:String(row.execution_state),taskId:typeof row.task_id==='string'?row.task_id:null}));
    const attentionCount=Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${filter}`).get()!.n);
    return {role,total,attentionCount,items:page,nextCursor:page.at(-1)?.cursor??after,hasMore:rows.length>limit,paymentPerformed:false};
  }finally{db.close();}
}
