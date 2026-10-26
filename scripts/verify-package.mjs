import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { validateVersion } from './release-version.mjs';

const directory = resolve(process.argv[2]);
const files = readdirSync(directory).filter(name => name.endsWith('.tgz'));
assert.equal(files.length, 1);
const tarball = join(directory, files[0]);
const entries = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).split('\n');
for (const helper of ['hermes-setup-probe.py', 'hermes-skill-inventory.py', 'native-skill-runner.py']) assert.ok(entries.includes('package/runtime/' + helper), 'Missing runtime helper: ' + helper);
assert.ok(!entries.some(path => /(^|\/)_(?:archive)(\/|$)|package\/dist\/index\.|wallet_fixture|\.env(?:$|\.)/.test(path)), 'Legacy or private files entered the package');
const pkg = JSON.parse(readFileSync(new URL('../packages/typescript/package.json', import.meta.url), 'utf8'));
validateVersion(pkg.version);
const root = mkdtempSync(join(tmpdir(), 'envarpay-package-'));
try {
  writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  execFileSync('npm', ['install', '--offline', '--cache', join(root, 'empty-cache'), '--ignore-scripts', '--no-audit', '--no-fund', tarball], { cwd: root, stdio: 'inherit' });
  execFileSync(process.execPath, ['--input-type=module', '-e', "import {loadCommerceConfig} from '@envarai/envarpay'; import {CommerceServer,EnvarBalanceGate} from '@envarai/envarpay/server'; import {EnvarIntegration} from '@envarai/envarpay/envar'; import {EnvarWorkClient} from '@envarai/envarpay/connector'; if(!loadCommerceConfig||!CommerceServer||!EnvarBalanceGate||!EnvarIntegration||!EnvarWorkClient)throw Error('Missing public API');"], { cwd: root, stdio: 'inherit' });
  const cli = join(root, 'node_modules/@envarai/envarpay/dist/cli.js');
  assert.equal(execFileSync(process.execPath, [cli, '--version'], { encoding: 'utf8' }).trim(), pkg.version);
  assert.match(execFileSync(process.execPath, [cli, 'connector', '--help'], { encoding: 'utf8' }), /Envar Connector/);
  const state = join(root, 'state');
  execFileSync(process.execPath, [cli, 'init', '--directory', state], { stdio: 'inherit' });
  execFileSync(process.execPath, [cli, 'validate', '--config', join(state, 'seller.json')], { stdio: 'inherit' });
  console.log('Packed CLI, public exports and runtime helpers verified: ' + pkg.version);
} finally { rmSync(root, { recursive: true, force: true }); }
