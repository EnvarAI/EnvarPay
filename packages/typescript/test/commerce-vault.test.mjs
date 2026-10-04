import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {CredentialVault} from '../dist/commerce/vault.js';

test('private original authorizations survive restart and reject tampering or wrong key',()=>{
 const dir=mkdtempSync(join(tmpdir(),'envar-vault-'));try{
  const key=Buffer.alloc(32,7),vault=new CredentialVault(dir,key);key.fill(0);
  const value={signature:'private signed authorization',nonce:'original'};
  const ref=vault.put(value);assert.deepEqual(vault.get(ref),value);
  assert.deepEqual(new CredentialVault(dir,Buffer.alloc(32,7)).get(ref),value);
  assert.equal(readFileSync(join(dir,ref)).includes(Buffer.from(value.signature)),false);
  assert.throws(()=>new CredentialVault(dir,Buffer.alloc(32,8)).get(ref),/integrity/);
  assert.throws(()=>vault.get('../invalid'),/reference/);
  const bytes=readFileSync(join(dir,ref));bytes[bytes.length-1]^=1;writeFileSync(join(dir,ref),bytes);
  assert.throws(()=>vault.get(ref),/integrity/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
