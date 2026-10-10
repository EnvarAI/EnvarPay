import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { activateManagedProfile, managedProfile } from '../dist/commerce/managed.js';
import { readSkillInventory } from '../dist/commerce/native-inventory.js';
import { probeOpenClaw } from '../dist/commerce/openclaw-setup.js';
import { SkillDiscovery } from '../dist/commerce/discovery.js';

const agentId = '11111111-2222-4333-8444-555555555555';
function save(path, value) { writeFileSync(path, JSON.stringify(value), { mode: 0o600 }); }
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'envar-managed-'));
  save(join(root, 'seller.json'), { configVersion: 2, agent: { id: 'bootstrap', name: 'Bootstrap' }, services: [], paymentProfiles: {} });
  const profile = join(root, 'profiles', agentId); mkdirSync(profile, { recursive: true, mode: 0o700 });
  save(join(profile, 'connection.json'), { agentId });
  return { root, profile };
}

test('managed activation preserves bootstrap ledger and binds one exact Agent', () => {
  const {root, profile} = fixture();
  try {
    const db = new DatabaseSync(join(root, 'seller.sqlite3'));
    db.exec('CREATE TABLE commerce_orders (id TEXT); CREATE TABLE commerce_service_revisions (id TEXT)'); db.close();
    const before = readFileSync(join(root, 'seller.sqlite3'));
    assert.equal(managedProfile(root), root);
    activateManagedProfile(root, agentId, profile);
    assert.equal(managedProfile(root), profile);
    activateManagedProfile(root, agentId, profile);
    assert.deepEqual(readFileSync(join(root, 'seller.sqlite3')), before);
    const other = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const otherProfile = join(root, 'profiles', other); mkdirSync(otherProfile, {mode:0o700});
    save(join(otherProfile, 'connection.json'), {agentId:other});
    assert.throws(() => activateManagedProfile(root, other, otherProfile), /another Agent/);
    assert.equal(managedProfile(root), profile);
  } finally { rmSync(root, {recursive:true,force:true}); }
});

test('managed activation refuses prior commerce history even after its offers were removed', () => {
  const {root, profile} = fixture();
  try {
    const db = new DatabaseSync(join(root,'seller.sqlite3')); db.exec("CREATE TABLE commerce_orders (id TEXT); INSERT INTO commerce_orders VALUES ('original-order')"); db.close();
    assert.throws(() => activateManagedProfile(root,agentId,profile), /existing seller ledger/);
    assert.equal(managedProfile(root),root);
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test('native inventory and web enablement share the same package digest', async () => {
  const root=mkdtempSync(join(tmpdir(),'envar-inventory-'));
  try {
    const installed=join(root,'installed'), source=join(installed,'copywriting'), enabled=join(root,'enabled');
    mkdirSync(source,{recursive:true}); mkdirSync(enabled);
    writeFileSync(join(source,'SKILL.md'),'---\nname: copywriting\ndescription: >\n  Write a concise description.\n---\nWrite only the requested text.\n');
    writeFileSync(join(source,'参考.md'),'Reference text.');
    mkdirSync(join(source,'.clawhub'));
    writeFileSync(join(source,'.clawhub/origin.json'),'{"source":"clawhub","untrusted":"not model instructions"}');
    const inventory=readSkillInventory([installed]); assert.equal(inventory.length,1);assert.equal(inventory[0].supported,true);
    const discovery=new SkillDiscovery({framework:'openclaw',skillsDirectory:enabled,freeSkills:[],stateDirectory:join(root,'tasks'),python:'python3',model:'test',baseUrl:'https://model.example',apiKeyFile:join(root,'key')},{hermesHome:root,roots:[installed],enabledFromWeb:true},'https://seller.example');
    const allowed=[];
    await discovery.sync({reportRuntime:async report=>{assert.equal(report.skills[0].digest,inventory[0].digest);return [{name:'copywriting',digest:inventory[0].digest}]},allowInstalledService:name=>allowed.push(name)},[]);
    assert.ok(readFileSync(join(enabled,'copywriting','SKILL.md'),'utf8').includes('envar-runtime: instruction-only'));
    assert.deepEqual(allowed,['copywriting']);
    assert.equal(existsSync(join(enabled,'copywriting/.clawhub/origin.json')),false,'installer metadata is never supplied to execution');
    assert.equal(existsSync(join(source,'.clawhub/origin.json')),true,'native installer provenance remains intact');
    writeFileSync(join(source,'.clawhub/origin.json'),'{"source":"updated"}');
    assert.notEqual(readSkillInventory([installed])[0].digest,inventory[0].digest,'metadata remains in the owner-approved source digest');
    writeFileSync(join(source,'.clawhub/execute.json'),'{}');
    assert.equal(readSkillInventory([installed])[0].supported,false,'other metadata-like files remain unsupported');
    rmSync(join(source,'.clawhub/execute.json'));
    rmSync(join(source,'.clawhub/origin.json'));
    symlinkSync(join(source,'参考.md'),join(source,'.clawhub/origin.json'));
    assert.equal(readSkillInventory([installed])[0].supported,false,'allowlisted metadata cannot be a symlink');
    rmSync(join(source,'.clawhub/origin.json'));
    symlinkSync(join(root,'key'),join(source,'key-link'));
    assert.equal(readSkillInventory([installed])[0].supported,false);
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test('OpenClaw setup keeps the selected model and resolves only its local environment credential', () => {
  const root=mkdtempSync(join(tmpdir(),'envar-openclaw-')), oldPath=process.env.PATH, oldKey=process.env.ENVAR_TEST_MODEL_KEY;
  try {
    const bin=join(root,'bin');mkdirSync(bin);writeFileSync(join(bin,'openclaw'),'#!/bin/sh\necho OpenClaw-test\n',{mode:0o700});
    process.env.PATH=bin+':'+oldPath;process.env.ENVAR_TEST_MODEL_KEY='fixture-key';
    save(join(root,'openclaw.json'),{agents:{defaults:{model:{primary:'selected/model-a',fallbacks:['other/model-b']}}},models:{providers:{selected:{baseUrl:'https://model.example/openai',api:'openai-completions',apiKey:'${ENVAR_TEST_MODEL_KEY}'}}}});
    const value=probeOpenClaw(root);assert.equal(value.model,'model-a');assert.equal(value.apiKey,'fixture-key');assert.equal(value.baseUrl,'https://model.example/openai');
    delete process.env.ENVAR_TEST_MODEL_KEY;
    assert.throws(()=>probeOpenClaw(root),/locally available API key/);
  } finally {process.env.PATH=oldPath;if(oldKey===undefined)delete process.env.ENVAR_TEST_MODEL_KEY;else process.env.ENVAR_TEST_MODEL_KEY=oldKey;rmSync(root,{recursive:true,force:true});}
});

test('Hermes setup reads a custom provider key_env used by managed deployments', () => {
  const root=mkdtempSync(join(tmpdir(),'envar-hermes-'));
  try {
    save(join(root,'config.yaml'),{model:{default:'configured-model',provider:'custom:platform'},providers:{platform:{api:'https://model.example/claude',key_env:'ENVAR_TEST_HERMES_KEY'}}});
    const output=execFileSync('python3',[new URL('../examples/hermes-setup-probe.py',import.meta.url).pathname,root],{env:{...process.env,ENVAR_TEST_HERMES_KEY:'fixture-key'},encoding:'utf8'});
    const value=JSON.parse(output);assert.equal(value.model,'configured-model');assert.equal(value.apiKey,'fixture-key');assert.deepEqual(value.skillRoots,[join(realpathSync(root),'skills')]);
  } finally {rmSync(root,{recursive:true,force:true});}
});
