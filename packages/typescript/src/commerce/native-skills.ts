/** Owner-operated, instruction-only skill runtime. No model file, shell or network tools. */
import { AgentCard, Task } from '@a2a-js/sdk';
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { digest } from './config.js';
import { CommerceError, type Input } from './types.js';
import { skillScopedExecutor, type SkillDescriptor, type SkillInvocation } from './skill-gate.js';
import type { ExecuteOrder } from './server.js';

export interface NativeSkillSettings {
  framework: 'hermes' | 'openclaw';
  skillsDirectory: string;
  freeSkills: string[];
  stateDirectory: string;
  python: string;
  command?: string[];
  model: string;
  baseUrl: string;
  apiKeyFile: string;
}
interface InstalledSkill { descriptor: SkillDescriptor; instructions: string; }
const namePattern = /^[a-z][a-z0-9-]{0,63}$/;

/** Hash every resource; reject symlinks, unbounded packages and executable skill requirements. */
export function readInstalledSkills(root: string, freeSkills: readonly string[], cardUrl: string): InstalledSkill[] {
  const base = resolve(root), rootStat = lstatSync(base);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new CommerceError('skill_directory', 'Use a real installed skill directory');
  const output: InstalledSkill[] = [];
  for (const entry of readdirSync(base, {withFileTypes: true}).sort((a,b)=>a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.')) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink() || !namePattern.test(entry.name)) throw new CommerceError('skill_package', 'Use one real directory per exact skill name');
    const files: {path:string;sha256:string}[] = []; let total = 0;
    function walk(folder: string, prefix = ''): void {
      if (prefix.split('/').length > 12) throw new CommerceError('skill_size', 'Skill package nesting exceeds the supported limit');
      for (const item of readdirSync(folder, {withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {
        const path=join(folder,item.name), relative=prefix+item.name;
        if (item.isSymbolicLink()) throw new CommerceError('skill_symlink', 'Skill packages cannot contain symlinks');
        if (item.isDirectory()) {walk(path,relative+'/');continue;}
        const stat=lstatSync(path);
        if (!stat.isFile() || stat.size > 512*1024 || files.length >= 128 || (total+=stat.size)>1024*1024) throw new CommerceError('skill_size','Skill package exceeds supported size');
        files.push({path:relative,sha256:createHash('sha256').update(readFileSync(path)).digest('hex')});
      }
    }
    walk(join(base,entry.name));
    const instructions=readFileSync(join(base,entry.name,'SKILL.md'),'utf8');
    const front=/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(instructions)?.[1];
    const name=/^name:\s*["']?([a-z][a-z0-9-]*)["']?\s*$/m.exec(front??'')?.[1];
    if (name!==entry.name || instructions.length>48000) throw new CommerceError('skill_name_mismatch','SKILL.md name must match its installed directory');
    // This adapter deliberately supports only text-in/text-out workflows. Owners must use
    // a separately reviewed adapter for skills needing code, browsing, external APIs or files.
    if (!/^envar-runtime:\s*instruction-only\s*$/m.test(front??'')) throw new CommerceError('skill_runtime_required','Review and mark each compatible skill envar-runtime: instruction-only before publication');
    const description=/^description:\s*(.+)$/m.exec(front??'')?.[1]?.replace(/^["']|["']$/g,'')??name;
    const references=files.filter(file=>file.path!=='SKILL.md'&&file.path.endsWith('.md')).map(file=>`\n\n<skill-reference path="${file.path}">\n${readFileSync(join(base,entry.name,file.path),'utf8')}\n</skill-reference>`).join('');
    if(instructions.length+references.length>120000)throw new CommerceError('skill_size','Instruction resources exceed the supported context size');
    output.push({descriptor:{name,digest:digest(files),cardUrl,access:freeSkills.includes(name)?'free':'paid',description},instructions:instructions+references});
  }
  if (!output.length || output.length>32 || freeSkills.some(name=>!output.some(s=>s.descriptor.name===name))) throw new CommerceError('skill_inventory','Install between 1 and 32 skills and declare only installed free skills');
  // Free helpers are executable dependencies of every purchase, so their versions
  // and access-policy changes must invalidate the quote's selected skill digest too.
  const helpers=output.filter(s=>s.descriptor.access==='free').map(s=>({name:s.descriptor.name,digest:s.descriptor.digest}));
  for(const skill of output)skill.descriptor.digest=digest({package:skill.descriptor.digest,helpers});
  return output;
}

export function createNativeSkillExecutor(settings: NativeSkillSettings, origin: string, agentName: string): {execute:ExecuteOrder;close():Promise<void>} {
  if (!['hermes','openclaw'].includes(settings.framework) || !Array.isArray(settings.freeSkills) || !settings.python || !settings.model || !settings.baseUrl) throw new CommerceError('skill_settings','Configure a supported native skill runtime');
  const cardUrl=new URL('/.well-known/agent-card.json',origin).href;
  const installed=()=>readInstalledSkills(settings.skillsDirectory,settings.freeSkills,cardUrl);
  const initial=installed();
  mkdirSync(settings.stateDirectory,{recursive:true,mode:0o700});
  const stateStat=lstatSync(settings.stateDirectory);
  if (!stateStat.isDirectory() || stateStat.isSymbolicLink() || (stateStat.mode&0o077)!==0) throw new CommerceError('skill_state','Skill state must be owner-only');
  const db=new DatabaseSync(join(settings.stateDirectory,'skills.sqlite3'));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS skill_tasks (id TEXT PRIMARY KEY, order_id TEXT UNIQUE NOT NULL, binding TEXT NOT NULL, task_json TEXT NOT NULL)');
  for (const row of db.prepare('SELECT id,task_json FROM skill_tasks').all()) {
    const task=JSON.parse(String(row.task_json));
    if (task.status?.state==='TASK_STATE_WORKING') {
      task.status={state:'TASK_STATE_FAILED',message:{role:'ROLE_AGENT',messageId:randomUUID(),parts:[{text:'Native execution interrupted; inspect this original order'}]}};
      db.prepare('UPDATE skill_tasks SET task_json=? WHERE id=?').run(JSON.stringify(task),row.id as string);
    }
  }
  const inFlight=new Map<string,Promise<Task>>();
  const runner=fileURLToPath(new URL('../../examples/native-skill-runner.py',import.meta.url));
  function readTask(id:string, invocation:SkillInvocation):Task {
    const row=db.prepare('SELECT order_id,task_json FROM skill_tasks WHERE id=?').get(id);
    if (!row || row.order_id!==invocation.orderId) throw new CommerceError('skill_task_not_found','Original skill Task not found');
    return Task.fromJSON(JSON.parse(String(row.task_json)));
  }
  function executeProcess(payload:unknown):Promise<{output:string;framework:string;tools:string[];sessionId?:string}> {
    return new Promise((accept,reject)=>{
      const child=spawn(settings.python,[runner],{stdio:['pipe','pipe','pipe'],env:{PATH:process.env.PATH,LANG:'C.UTF-8',PYTHONUNBUFFERED:'1'}});
      const chunks:Buffer[]=[]; let size=0; const timeout=setTimeout(()=>child.kill('SIGTERM'),240000);
      child.stdout.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>1024*1024)child.kill('SIGTERM');else chunks.push(chunk);});
      child.stderr.resume();
      child.on('error',()=>{clearTimeout(timeout);reject(new CommerceError('skill_runtime_start','Native skill runtime could not start'));});
      child.on('close',code=>{clearTimeout(timeout);try {
        if(code!==0||size>1024*1024)throw Error();
        const result=JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if(typeof result.output!=='string'||!result.output.trim()||result.framework!==settings.framework||!Array.isArray(result.tools)||result.tools.length)throw Error();
        accept(result);
      }catch{reject(new CommerceError('skill_runtime_failed','Native skill execution failed; inspect the original Task without resubmitting'));}});
      child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(payload));
    });
  }
  const runtime={
    list:()=>installed().map(s=>s.descriptor),
    async send(name:string,input:Input,invocation:SkillInvocation):Promise<Task>{
      const skills=installed(), selected=skills.find(s=>s.descriptor.name===name);
      if(!selected || selected.descriptor.digest!==invocation.grant.skillDigest)throw new CommerceError('skill_changed','The purchased skill version is no longer installed');
      invocation.grant.require(name);
      const allowed=skills.filter(s=>s.descriptor.name===name||s.descriptor.access==='free');
      allowed.forEach(s=>invocation.grant.require(s.descriptor.name));
      const binding=digest({name,version:selected.descriptor.digest,caller:invocation.grant.caller,input,allowed:allowed.map(s=>s.descriptor)});
      const prior=db.prepare('SELECT id,binding FROM skill_tasks WHERE order_id=?').get(invocation.orderId);
      if(prior){
        if(prior.binding!==binding)throw new CommerceError('skill_task_conflict','An order already identifies a different skill input');
        return readTask(String(prior.id),invocation);
      }
      const id=randomUUID();
      // A crash cannot cause a second native dispatch. The durable Task remains failed until owner inspection.
      const pending=Task.fromJSON({id,status:{state:'TASK_STATE_WORKING'}});
      db.prepare('INSERT INTO skill_tasks VALUES (?,?,?,?)').run(id,invocation.orderId,binding,JSON.stringify(Task.toJSON(pending)));
      const operation=(async()=>{
        let task:Task;
        try{
          const result=await executeProcess({settings:{...settings,stateDirectory:join(settings.stateDirectory,id)},skillName:name,skills:allowed.map(s=>({name:s.descriptor.name,instructions:s.instructions})),input});
          task=Task.fromJSON({id,status:{state:'TASK_STATE_COMPLETED'},artifacts:[{artifactId:'result',name:name+'.md',parts:[{text:result.output,mediaType:'text/markdown'}]}],metadata:{skillName:name,skillDigest:selected.descriptor.digest,allowedSkills:allowed.map(s=>s.descriptor.name),framework:settings.framework,tools:result.tools,sessionId:result.sessionId??id}});
        }catch(error){task=Task.fromJSON({id,status:{state:'TASK_STATE_FAILED'},metadata:{errorCode:error instanceof CommerceError?error.code:'skill_runtime_failed'}});}
        db.prepare('UPDATE skill_tasks SET task_json=? WHERE id=?').run(JSON.stringify(Task.toJSON(task)),id);
        return task;
      })();
      inFlight.set(id,operation);void operation.finally(()=>inFlight.delete(id));return pending;
    },
    async getTask(_name:string,id:string,invocation:SkillInvocation){return readTask(id,invocation);},
  };
  const execute=skillScopedExecutor(runtime);
  execute.skillCard=()=>{
    const skills=installed();
    return AgentCard.fromJSON({name:agentName,description:'Installed Agent Skills',version:'1.0',supportedInterfaces:[{url:new URL('/a2a',origin).href,protocolBinding:'JSONRPC',protocolVersion:'1.0'}],capabilities:{extensions:[{uri:'urn:envarpay:skill-gate:1',required:false,params:{runtime:'instruction-only-v1',skills:skills.map(s=>({name:s.descriptor.name,digest:s.descriptor.digest,access:s.descriptor.access}))}}]},defaultInputModes:['application/json'],defaultOutputModes:['text/markdown'],skills:skills.map(s=>({id:s.descriptor.name,name:s.descriptor.name,description:s.descriptor.description,tags:[s.descriptor.name]}))});
  };
  if(initial.length===0)throw new CommerceError('skill_inventory','No installed skills');
  return {execute,close:async()=>{await Promise.allSettled(inFlight.values());db.close();}};
}
