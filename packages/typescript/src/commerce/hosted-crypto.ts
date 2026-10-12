import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { CommerceError } from './types.js';

/** Matches Envar's existing AES-GCM envelope: 12-byte nonce, ciphertext, 16-byte tag. */
export type HostedKeyring = {active:string;keys:Record<string,Buffer>;legacy?:Buffer};
export type HostedKey = Buffer | HostedKeyring;
const magic=Buffer.from('EVK1:');
export function validateHostedKeys(value:HostedKey):void {
  if(Buffer.isBuffer(value)){if(value.length!==32)throw new CommerceError('hosted_key','Invalid state key');return;}
  if(!value||!value.keys||!Object.hasOwn(value.keys,value.active)||Object.keys(value.keys).length>10||
    Object.entries(value.keys).some(([id,key])=>!/^[-A-Za-z0-9_]{1,32}$/.test(id)||!Buffer.isBuffer(key)||key.length!==32)||
    value.legacy&&value.legacy.length!==32)throw new CommerceError('hosted_key','Invalid versioned state keys');
}
export function sealHosted(material:HostedKey,id:string,purpose:'context'|'state',value:unknown):Buffer {
  validateHostedKeys(material);
  const header=Buffer.isBuffer(material)?Buffer.alloc(0):Buffer.from(`EVK1:${material.active}:`);
  const key=Buffer.isBuffer(material)?material:material.keys[material.active]!;
  if(key.length!==32)throw new CommerceError('hosted_key','A dedicated 32-byte state key is required');
  const plaintext=JSON.stringify(value);
  if(!plaintext||Buffer.byteLength(plaintext)>16*1024*1024)throw new CommerceError('hosted_state_size','Private state exceeds its limit');
  const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce);
  cipher.setAAD(Buffer.concat([header,Buffer.from(`envar-hosted-${purpose}:${id}`)]));
  return Buffer.concat([header,nonce,cipher.update(plaintext,'utf8'),cipher.final(),cipher.getAuthTag()]);
}

export function openHosted(material:HostedKey,id:string,purpose:'context'|'state',value:Buffer):unknown {
  validateHostedKeys(material);
  let header:Buffer=Buffer.alloc(0),key:Buffer|undefined;
  if(value.subarray(0,magic.length).equals(magic)){
    const end=value.indexOf(58,magic.length);
    if(end<magic.length+1||end>magic.length+32||Buffer.isBuffer(material))throw new CommerceError('hosted_key_missing','Original state key is unavailable');
    header=value.subarray(0,end+1);const name=value.subarray(magic.length,end).toString('ascii');
    key=Object.hasOwn(material.keys,name)?material.keys[name]:undefined;value=value.subarray(end+1);
  }else key=Buffer.isBuffer(material)?material:material.legacy;
  if(!key)throw new CommerceError('hosted_key_missing','Original state key is unavailable');
  if(key.length!==32||value.length<28||value.length>16*1024*1024+28)throw new CommerceError('hosted_state_integrity','Invalid private state envelope');
  try {
    const cipher=createDecipheriv('aes-256-gcm',key,value.subarray(0,12));
    cipher.setAAD(Buffer.concat([header,Buffer.from(`envar-hosted-${purpose}:${id}`)]));cipher.setAuthTag(value.subarray(-16));
    return JSON.parse(Buffer.concat([cipher.update(value.subarray(12,-16)),cipher.final()]).toString('utf8'));
  }catch{throw new CommerceError('hosted_state_integrity','Private state failed integrity verification');}
}

/** Each invocation gets its own memory vault; the containing checkpoint is encrypted in PostgreSQL. */
export class MemoryCredentialVault {
  private readonly values:Record<string,unknown>;
  constructor(saved:Record<string,unknown>={}) {
    if(!saved||typeof saved!=='object'||Array.isArray(saved)||Object.keys(saved).length>32)throw new CommerceError('hosted_vault','Invalid private vault checkpoint');
    this.values=structuredClone(saved);
  }
  put(value:unknown):string {
    const text=JSON.stringify(value);
    if(!text||Buffer.byteLength(text)>65536||Object.keys(this.values).length>=32)throw new CommerceError('hosted_vault_size','Authorization exceeds its private vault limit');
    const id=randomUUID();this.values[id]=JSON.parse(text);return id;
  }
  get(id:string):unknown {
    if(!Object.hasOwn(this.values,id))throw new CommerceError('vault_reference','Original credential is missing');
    return structuredClone(this.values[id]);
  }
  snapshot():Record<string,unknown>{return structuredClone(this.values);}
}
