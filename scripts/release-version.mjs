import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function validateVersion(version) {
  const match = /^(\d{4})\.([1-9]\d{2,3})\.([1-9]\d*)$/.exec(version);
  assert.ok(match, 'Use a stable calendar version such as 2026.1025.1');
  const year = Number(match[1]), monthDay = Number(match[2]);
  const month = Math.floor(monthDay / 100), day = monthDay % 100;
  const date = new Date(Date.UTC(year, month - 1, day));
  assert.ok(date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day, 'Version must contain a real calendar date');
  assert.ok(Number.isSafeInteger(Number(match[3])), 'Release sequence is too large');
  return [year, monthDay, Number(match[3])];
}

export function compareVersions(left, right) {
  const parts = value => value.split('-')[0].split('.').map(Number);
  const a = parts(left), b = parts(right);
  for (let index = 0; index < 3; index++) {
    assert.ok(Number.isSafeInteger(a[index]) && Number.isSafeInteger(b[index]), 'Invalid registry version');
    if (a[index] !== b[index]) return Math.sign(a[index] - b[index]);
  }
  return Number(!left.includes('-')) - Number(!right.includes('-'));
}

export function nextVersion(current, now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: 'numeric', day: 'numeric'
  }).formatToParts(now).map(part => [part.type, part.value]));
  const prefix = parts.year + '.' + (Number(parts.month) * 100 + Number(parts.day));
  const first = prefix + '.1';
  if (/^\d{4}\.[1-9]\d{2,3}\.[1-9]\d*$/.test(current)) {
    const previous = validateVersion(current);
    if (current.startsWith(prefix + '.')) return prefix + '.' + (previous[2] + 1);
    assert.ok(compareVersions(first, current) > 0, 'Do not move the release date backwards');
  }
  return first;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const packageFile = new URL('../packages/typescript/package.json', import.meta.url);
  const lockFile = new URL('../packages/typescript/package-lock.json', import.meta.url);
  const pkg = JSON.parse(readFileSync(packageFile, 'utf8'));
  const lock = JSON.parse(readFileSync(lockFile, 'utf8'));
  const version = nextVersion(pkg.version);
  validateVersion(version);
  pkg.version = lock.version = lock.packages[''].version = version;
  writeFileSync(packageFile, JSON.stringify(pkg, null, 2) + '\n');
  writeFileSync(lockFile, JSON.stringify(lock, null, 2) + '\n');
  console.log(version);
}
