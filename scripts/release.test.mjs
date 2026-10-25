import test from 'node:test';
import assert from 'node:assert/strict';
import { validateVersion, nextVersion } from './release-version.mjs';
import { npmPublication, npmResult } from './release.mjs';

test('calendar versions use the Shanghai date and advance each release', () => {
  const now = new Date('2026-10-24T16:01:00Z');
  assert.equal(nextVersion('0.2.0-alpha.20', now), '2026.1025.1');
  assert.equal(nextVersion('2026.1025.1', now), '2026.1025.2');
  assert.equal(nextVersion('2026.1231.8', new Date('2027-01-04T16:00:00Z')), '2027.105.1');
  assert.throws(() => nextVersion('2026.1026.1', now), /backwards/);
});

test('release versions reject prereleases, padded components and invalid dates', () => {
  for (const version of ['20261025.1', '2026.0105.1', '2026.229.1', '2026.1331.1', '2026.1025.0', '2026.1025.1-alpha']) assert.throws(() => validateVersion(version));
  assert.deepEqual(validateVersion('2028.229.1'), [2028, 229, 1]);
});

test('npm retries only reuse the identical artifact and never downgrade latest', () => {
  const name = '@envarai/envarpay', version = '2026.1025.1', integrity = 'sha512-fixture';
  const metadata = { name, 'dist-tags': { latest: version }, versions: { [version]: { dist: { integrity } } } };
  assert.equal(npmPublication(null, name, version, integrity), true);
  assert.equal(npmPublication(metadata, name, version, integrity), false);
  assert.throws(() => npmPublication(metadata, name, version, 'sha512-other'), /differs/);
  assert.throws(() => npmPublication({ ...metadata, name: '@someone/else' }, name, version, integrity), /different package/);
  assert.throws(() => npmPublication({ ...metadata, 'dist-tags': { latest: '2026.1025.2' } }, name, version, integrity), /backwards/);
});

test('only a confirmed registry 404 permits a missing package or version', () => {
  assert.equal(npmResult({ status: 1, stdout: JSON.stringify({ error: { code: 'E404' } }) }, true), null);
  for (const code of ['E403', 'E401', 'ETIMEDOUT', 'E500']) assert.throws(() => npmResult({ status: 1, stdout: JSON.stringify({ error: { code } }) }, true), /failed/);
  assert.throws(() => npmResult({ status: 0, stdout: 'not json' }, true), /invalid JSON/);
  assert.throws(() => npmResult({ error: new Error('timeout'), stdout: '' }, true), /did not complete/);
});
