import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {readInstalledSkills,createNativeSkillExecutor} from '../dist/commerce/native-skills.js';
import {SkillGrant} from '../dist/commerce/skill-gate.js';
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'envar-skills-')),skills=join(root,'skills');mkdirSync(skills);
 for(const name of ['research','short-drama','free-helper']){mkdirSync(join(skills,name));writeFileSync(join(skills,name,'SKILL.md'),`---\nname: ${name}\ndescription: ${name}\nenvar-runtime: instruction-only\n---\nFollow the ${name} procedure.\n`);}
 return {root,skills,close:()=>rmSync(root,{recursive:true,force:true})};
}
test('inventory hashes resources, uses exact installed names, and rejects symlink escape',()=>{
 const f=fixture();try{
  const read=()=>readInstalledSkills(f.skills,['free-helper'],'https://agent.example/.well-known/agent-card.json');
  const a=read();assert.equal(a.length,3);assert.equal(a.find(s=>s.descriptor.name==='free-helper').descriptor.access,'free');
  writeFileSync(join(f.skills,'research','reference.md'),'version two');
  assert.notEqual(read().find(s=>s.descriptor.name==='research').descriptor.digest,a.find(s=>s.descriptor.name==='research').descriptor.digest);
  symlinkSync(join(f.skills,'short-drama','SKILL.md'),join(f.skills,'research','escape'));
  assert.throws(read,e=>e.code==='skill_symlink');
 }finally{f.close();}
});
test('unsupported native skill packages fail before publication; unpaid grant is impossible',()=>{
 const f=fixture();try{
  writeFileSync(join(f.skills,'research','SKILL.md'),'---\nname: research\n---\nExecute a shell command.');
  assert.throws(()=>readInstalledSkills(f.skills,[],'https://agent.example/card'),e=>e.code==='skill_runtime_required');
  assert.throws(()=>new SkillGrant({paymentState:'quoted'},{name:'research'},new Set()),e=>e.code==='payment_required');
 }finally{f.close();}
});
test('native executor publishes multiple skills and validates the selected installed digest',async()=>{
 const f=fixture();try{
  const origin='https://agent.example';const {execute,close}=createNativeSkillExecutor({framework:'hermes',skillsDirectory:f.skills,freeSkills:['free-helper'],stateDirectory:join(f.root,'state'),python:'/not/executed',model:'owner-model',baseUrl:'https://model.example/v1',apiKeyFile:'/not/read'},origin,'Owner Agent');
  try{assert.deepEqual(execute.skillCard().skills.map(s=>s.id),['free-helper','research','short-drama']);
    const descriptor=readInstalledSkills(f.skills,['free-helper'],origin+'/.well-known/agent-card.json').find(s=>s.descriptor.name==='research').descriptor;
    execute.assertSkill({id:'research',name:'research',execution:{type:'skill',cardUrl:descriptor.cardUrl,skillDigest:descriptor.digest},offers:[]});
    assert.throws(()=>execute.assertSkill({id:'rocket',name:'rocket',execution:{type:'skill',cardUrl:descriptor.cardUrl,skillDigest:descriptor.digest},offers:[]}),e=>e.code==='skill_unavailable');
  }finally{await close();}
 }finally{f.close();}
});
