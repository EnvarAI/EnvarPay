import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { digest } from '../dist/commerce/config.js';
import { CommerceError } from '../dist/commerce/types.js';
import { CommerceError as ConnectError } from '@envarai/connect/shared';
const read = name => JSON.parse(readFileSync(new URL('../schemas/' + name, import.meta.url)));
test('seller digest matches the published cross-language vectors after extraction', () => {
  for (const row of read('digest-vectors.json')) assert.equal(digest(row.value), row.sha256);
  assert.equal(CommerceError, ConnectError);
  assert.throws(() => digest({amount: Number.MAX_SAFE_INTEGER + 1}), CommerceError);
});
test('seller claim schema accepts the documented fields and rejects replacement terms', () => {
  const ajv = new Ajv2020({strict:true}); addFormats(ajv);
  const validate=ajv.compile(read('balance-claim.v1.schema.json'));
  const value={claim_token:'test-only-claim-'.repeat(3),task_id:'11111111-1111-4111-8111-111111111111',
    quote_id:'quote-1',message_id:'22222222-2222-4222-8222-222222222222',service_id:'summary',service_revision:1,
    offer_id:'paid',input_digest:'a'.repeat(64),terms_digest:'b'.repeat(64),amount:'100',currency:'usd',recipient:'envar'};
  assert.ok(validate(value));
  for(const changed of [{...value,amount:100},{...value,currency:'eur'},{...value,amount:'-1'},{...value,extra:'replace'}]) assert.equal(validate(changed),false);
});
