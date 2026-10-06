/** Agent-driven installation. Secrets stay in local files; receipts come from Envar. */
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { setupHermes, parseSetupBundle } from './setup.js';
import { CommerceError } from './types.js';

interface Invitation { version:1; agentId:string; platformOrigin:string; setupToken:string; }
function privateJson(file:string):any {
 const s=lstatSync(file);
 if(!s.isFile()||s.isSymbolicLink()||s.size>16384||(s.mode&0o077))throw new CommerceError('setup_private_file','Save the setup invitation in an owner-only file (chmod600).');
 return JSON.parse(readFileSync(file,'utf8'));
}
export function invitation(value:any):Invitation {
 if(value?.version!==1||!/^[0-9a-f-]{36}$/.test(value.agentId)||!/^envar_setup_[A-Za-z0-9_-]{43}$/.test(value.setupToken))throw new CommerceError('setup_invitation','Copy a fresh setup prompt.');
 const url=new URL(value.platformOrigin);
 if(url.protocol!=='https:'||url.origin!==value.platformOrigin||url.username||url.password)throw new CommerceError('setup_origin','Use the exact Envar HTTPS origin.');
 return value;
}
async function request(invite:Invitation,path:string,data:unknown):Promise<any> {
 const r=await fetch(invite.platformOrigin+'/api/v1/agent-setup/'+path,{method:'POST',redirect:'error',headers:{Authorization:'Bearer '+invite.setupToken,'Content-Type':'application/json'},body:JSON.stringify(data),signal:AbortSignal.timeout(45000)});
 if(!r.ok)throw new CommerceError('setup_'+path,`Envar ${path} returned ${r.status}. Check connection or copy a fresh prompt; do not report success.`);
 const text=await r.text();if(text.length>65536)throw new CommerceError('setup_response','Envar returned an oversized response.');return JSON.parse(text);
}
async function freePort():Promise<number> {
 const socket=createServer();await new Promise<void>((resolve,reject)=>{socket.once('error',reject);socket.listen(0,'127.0.0.1',resolve)});
 const port=(socket.address() as {port:number}).port;await new Promise<void>(resolve=>socket.close(()=>resolve()));return port;
}
function save(file:string,data:unknown){writeFileSync(file,JSON.stringify(data,null,2)+'\n',{mode:0o600,flag:'wx'});}
async function publicOrigin(root:string,port:number,agentId:string,supplied?:string):Promise<string> {
 if(supplied){const u=new URL(supplied);if(u.protocol!=='https:'||u.origin!==supplied)throw Error('Use a public HTTPS origin');return supplied;}
 // Use an available existing tunnel session, without deleting or rebinding any endpoint.
 for(const apiPort of [4040,4041,4042,4043]){
  try {
   const api=`http://127.0.0.1:${apiPort}`;
   const r=await fetch(api+'/api/tunnels',{signal:AbortSignal.timeout(1000)});if(!r.ok)continue;
   const list=(await r.json()) as any;
   const name='envarpay-'+agentId,addr=`http://127.0.0.1:${port}`;
   const prior=list.tunnels?.find((t:any)=>t.name===name);
   if(prior){if(prior.config.addr!==addr)continue;return prior.public_url;}
   if(list.tunnels?.length>=3)continue;
   const created=await fetch(api+'/api/tunnels',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,proto:'http',addr,schemes:['https'],inspect:false}),signal:AbortSignal.timeout(12000)});
   if(created.ok)return ((await created.json()) as any).public_url;
  }catch{}
 }
 // Outbound HTTPS works inside Docker too; never requires a Docker socket or host port mapping.
 const log=join(root,'tunnel.log');if(existsSync(log))privateLog(log);
 const offset=existsSync(log)?readFileSync(log,'utf8').length:0,fd=openSync(log,'a',0o600);
 const tunnel=spawn('cloudflared',['tunnel','--url',`http://127.0.0.1:${port}`,'--no-autoupdate'],{detached:true,stdio:['ignore',fd,fd]});closeSync(fd);
 let failed=false;tunnel.on('error',()=>{failed=true});tunnel.unref();
 for(let i=0;i<45;i++){
  if(failed)break;
  await new Promise(resolve=>setTimeout(resolve,1000));
  const url=readFileSync(log,'utf8').slice(offset).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/)?.[0];
  if(url){writeFileSync(join(root,'tunnel-process.json'),JSON.stringify({pid:tunnel.pid,origin:url,temporary:true}),{mode:0o600});return url;}
 }
 if(tunnel.pid)try{tunnel.kill()}catch{}
 throw new CommerceError('setup_https','Install cloudflared from its official distribution, or supply --origin with an existing HTTPS forwarder. Preserve other tunnels.');
}
function privateLog(file:string){const s=lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||(s.mode&0o077))throw new CommerceError('setup_private_file','Runtime log must be an owner-only regular file.');}
export async function agentSetup(options:{file:string;directory?:string;python?:string;home?:string;container?:string;origin?:string;port?:number;checkOnly?:boolean}):Promise<void>{
 const invite=invitation(privateJson(resolve(options.file)));
 const profile=resolve(options.directory??join(homedir(),'.envarpay',invite.agentId));
 const root=profile+'.onboarding';
 if(options.checkOnly){const result=await request(invite,'status',{});if(result.agent_id!==invite.agentId)throw new CommerceError('setup_identity','Receipt belongs to another Agent.');console.log(JSON.stringify(result,null,2));if(result.status!=='connected')process.exitCode=1;return;}
 mkdirSync(root,{recursive:true,mode:0o700});if(lstatSync(root).isSymbolicLink()||(lstatSync(root).mode&0o077))throw new CommerceError('setup_directory','Use a private directory owned by this user.');

 const manifest=join(root,'setup.json');
 if(existsSync(manifest)&&privateJson(manifest).agentId!==invite.agentId)throw new CommerceError('setup_identity','This directory belongs to another Agent.');
 const bundle=parseSetupBundle(await request(invite,'claim',{}));
 if(bundle.agentId!==invite.agentId||bundle.platformOrigin!==invite.platformOrigin)throw new CommerceError('setup_identity','Envar returned another Agent identity.');
 const bundleFile=join(root,'bundle.json');if(existsSync(bundleFile))privateJson(bundleFile);writeFileSync(bundleFile,JSON.stringify(bundle),{mode:0o600});
 if(!existsSync(profile)){
  let settings=existsSync(manifest)?privateJson(manifest):undefined;
  if(!settings){const port=options.port??await freePort();const origin=await publicOrigin(root,port,invite.agentId,options.origin);settings={agentId:invite.agentId,port,origin};save(manifest,settings);}
  await setupHermes({file:bundleFile,directory:profile,python:options.python,home:options.home,container:options.container,automatic:settings});
 }
 if(lstatSync(profile).isSymbolicLink()||(lstatSync(profile).mode&0o077))throw new CommerceError('setup_directory','The runtime must be a private directory.');
 const connection=privateJson(join(profile,'connection.json'));
 privateLog(join(profile,'envar.token'));
 const launcher=lstatSync(join(profile,'start.mjs'));if(!launcher.isFile()||launcher.isSymbolicLink()||(launcher.mode&0o077))throw new CommerceError('setup_private_file','Use the original private runtime launcher.');
 if(connection.agentId!==invite.agentId)throw new CommerceError('setup_identity','Existing runtime belongs to another Agent.');
 const policy=privateJson(join(profile,'envar.json')).policy;
 if(policy.agentId!==invite.agentId||policy.platformOrigin!==invite.platformOrigin)throw new CommerceError('setup_identity','Existing integration belongs to another Agent.');
 const running=join(root,'process.json');let started=false;
 if(existsSync(running))try{process.kill(privateJson(running).pid,0);started=true}catch{}
 if(started&&readFileSync(join(profile,'envar.token'),'utf8')!==bundle.token)throw new CommerceError('setup_running','Existing runtime uses an earlier credential. Stop its recorded process, keep its ledger, then retry this invitation.');
 if(!started){
  privateLog(join(profile,'envar.token'));
  writeFileSync(join(profile,'envar.token'),bundle.token,{mode:0o600});
  const log=join(root,'runtime.log');if(existsSync(log))privateLog(log);
  const fd=openSync(log,'a',0o600),child=spawn(process.execPath,[join(profile,'start.mjs')],{detached:true,stdio:['ignore',fd,fd]});closeSync(fd);child.unref();
  writeFileSync(running,JSON.stringify({pid:child.pid}),{mode:0o600});
 }
 let result:any;
 for(let attempt=0;attempt<12;attempt++){
  try{result=await request(invite,'connect',{agentId:invite.agentId,url:connection.url,authToken:connection.authToken});if(result.status==='connected')break;}catch(e){if(attempt===11)throw e;}
  await new Promise(resolve=>setTimeout(resolve,3000));
 }
 result=await request(invite,'status',{});
 if(result.status!=='connected'||result.agent_id!==invite.agentId||!result.verified_at)throw new CommerceError('setup_unverified','Platform did not verify this setup. Keep files and report the blocker.');
 const output={...result,local_directory:profile,receipt_file:join(root,'receipt.json'),scope:'connected; not published; no payment',restart:`node ${JSON.stringify(join(profile,'start.mjs'))}`,temporary_tunnel:!options.origin,automatic_restart:false};
 if(existsSync(join(root,'receipt.json')))privateJson(join(root,'receipt.json'));
 writeFileSync(join(root,'receipt.json'),JSON.stringify(output,null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify(output,null,2));
}
