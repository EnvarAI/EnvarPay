import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {invitation,agentSetup} from '../dist/commerce/agent-setup.js';
const invite={version:1,agentId:'54fe760a-4580-4258-9002-80f34c0d757a',platformOrigin:'https://envar.example',setupToken:'envar_setup_'+'a'.repeat(43)};
test('setup invitation rejects credential URLs and unscoped tokens',()=>{
 assert.equal(invitation(invite).agentId,invite.agentId);
 for(const changed of [{platformOrigin:'http://envar.example'},{platformOrigin:'https://u:p@envar.example'},{platformOrigin:'https://envar.example/path'},{setupToken:'envar_agent_'+'b'.repeat(43)}])assert.throws(()=>invitation({...invite,...changed}));
});
test('onboard resumes the original runtime and emits only a platform verified receipt without credentials',async()=>{
 const root=mkdtempSync(join(tmpdir(),'envar-agent-setup-')),profile=join(root,'profile'),state=profile+'.onboarding';mkdirSync(profile,{mode:0o700});mkdirSync(state,{mode:0o700});
 const save=(path,value)=>writeFileSync(path,JSON.stringify(value),{mode:0o600});const file=join(root,'invitation.json');save(file,invite);
 const token='envar_agent_'+'c'.repeat(64),access='d'.repeat(48);save(join(profile,'connection.json'),{agentId:invite.agentId,url:'https://seller.example/.well-known/agent-card.json',authToken:access});save(join(profile,'envar.json'),{policy:{agentId:invite.agentId,platformOrigin:invite.platformOrigin}});writeFileSync(join(profile,'envar.token'),token,{mode:0o600});writeFileSync(join(profile,'seller.sqlite3'),'original-ledger');writeFileSync(join(profile,'start.mjs'),'// existing launcher',{mode:0o700});save(join(state,'process.json'),{pid:process.pid});
 const originalFetch=global.fetch,originalLog=console.log,calls=[],logs=[];
 const receipt={status:'connected',agent_id:invite.agentId,verified_at:'2026-10-07T00:00:00Z',skills:[],services_url:invite.platformOrigin+'/agents/'+invite.agentId+'/services'};
 global.fetch=async(url,init)=>{calls.push({url,init});return Response.json(url.endsWith('/claim')?{version:1,agentId:invite.agentId,agentName:'Hermes',runtimeAgentId:'my-hermes',platformOrigin:invite.platformOrigin,token,expiresAt:'2099-01-01T00:00:00Z'}:receipt)};
 console.log=value=>logs.push(value);
 try{
  await agentSetup({file,directory:profile});
  assert.deepEqual(calls.map(c=>c.url.split('/').at(-1)),['claim','connect','status']);
  assert.ok(calls.every(c=>c.init.redirect==='error'&&c.init.headers.Authorization==='Bearer '+invite.setupToken));
  assert.equal(readFileSync(join(profile,'seller.sqlite3'),'utf8'),'original-ledger');
  assert.ok(logs[0].includes('connected'));assert.ok(!logs[0].includes(token)&&!logs[0].includes(access)&&!logs[0].includes(invite.setupToken));
  assert.equal(JSON.parse(readFileSync(join(state,'receipt.json'))).agent_id,invite.agentId);
 }finally{global.fetch=originalFetch;console.log=originalLog;rmSync(root,{recursive:true,force:true})}
});
