import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const source = new URL('../packages/typescript/schemas/agent-work.v1.schema.json', import.meta.url);
const target = new URL('../packages/typescript/src/connector/contracts.generated.ts', import.meta.url);
const text = readFileSync(source, 'utf8'), schema = JSON.parse(text);
const name = value => value.split('_').map(part => part[0].toUpperCase() + part.slice(1)).join('');
function type(s) {
  if (s.$ref) return name(s.$ref.split('/').at(-1));
  if (s.anyOf) return s.anyOf.map(type).join(' | ');
  if (s.enum) return s.enum.map(value => JSON.stringify(value)).join(' | ');
  if (Array.isArray(s.type)) return s.type.map(value => type({ ...s, type: value })).join(' | ');
  if (s.type === 'array') return `Array<${type(s.items)}>`;
  if (s.type === 'object') {
    if (!s.properties) return 'Record<string, unknown>';
    return `{\n${Object.entries(s.properties).map(([key, value]) => `  ${JSON.stringify(key)}${s.required?.includes(key) ? '' : '?'}: ${type(value)};`).join('\n')}\n}`;
  }
  if (s.type === 'integer' || s.type === 'number') return 'number';
  return ['string', 'boolean', 'null'].includes(s.type) ? s.type : 'unknown';
}
const generated = `// Generated from the canonical Envar Agent Work v1 JSON Schema. Do not edit.\n// Source: EnvarAI/EnvarAI server/contracts/agent-work/v1/schema.json\nexport const WORK_SCHEMA_SHA256 = '${createHash('sha256').update(text).digest('hex')}';\n\n` +
  Object.entries(schema.$defs).map(([key, value]) => `export type ${name(key)} = ${type(value)};\n`).join('\n');
if (process.argv.includes('--check')) {
  if (readFileSync(target, 'utf8') !== generated) throw new Error('Run node scripts/generate-work-contract.mjs');
} else writeFileSync(target, generated);
