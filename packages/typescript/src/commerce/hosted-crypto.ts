import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { CommerceError } from './types.js';

/** Matches Envar's existing AES-GCM envelope: 12-byte nonce, ciphertext, 16-byte tag. */
export function sealHosted(key:Buffer,id:string,purpose:'context'|'state',value:unknown):Buffer {
  if(key.length!==32)throw new CommerceError('hosted_key','A dedicated 32-byte state key is required');
  const plaintext=JSON.stringify(value);
  if(!plaintext||Buffer.byteLength(plaintext)>16*1024*1024)throw new CommerceError('hosted_state_size','Private state exceeds its limit');
  const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce);
  cipher.setAAD(Buffer.from(`envar-hosted-${purpose}:${id}`));
  return Buffer.concat([nonce,cipher.update(plaintext,'utf8'),cipher.final(),cipher.getAuthTag()]);
}

export function openHosted(key:Buffer,id:string,purpose:'context'|'state',value:Buffer):unknown {
  if(key.length!==32||value.length<28||value.length>16*1024*1024+28)throw new CommerceError('hosted_state_integrity','Invalid private state envelope');
  try {
    const cipher=createDecipheriv('aes-256-gcm',key,value.subarray(0,12));
    cipher.setAAD(Buffer.from(`envar-hosted-${purpose}:${id}`));cipher.setAuthTag(value.subarray(-16));
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
