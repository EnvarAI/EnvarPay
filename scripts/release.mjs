import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';
import { compareVersions, validateVersion } from './release-version.mjs';

export function npmPublication(metadata, name, version, integrity) {
  validateVersion(version);
  if (!metadata) return true;
  assert.equal(metadata.name, name, 'Registry returned a different package');
  const latest = metadata['dist-tags']?.latest;
  assert.ok(!latest || compareVersions(version, latest) >= 0, 'Refusing to move latest backwards');
  const existing = metadata.versions?.[version];
  if (!existing) return true;
  assert.equal(existing.dist?.integrity, integrity, 'Published version differs from this tarball; create a new version');
  return false;
}

export async function waitForNpmPublication(readMetadata, name, version, integrity, {
  attempts = 60, delay = () => new Promise(resolve => setTimeout(resolve, 5000))
} = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const metadata = await readMetadata();
    if (!npmPublication(metadata, name, version, integrity) && metadata['dist-tags']?.latest === version) return;
    if (attempt + 1 < attempts) await delay();
  }
  throw new Error('npm version or latest is still not visible; retry this original release run');
}

function output(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, name + '=' + value + '\n');
  console.log(name + '=' + value);
}

export function npmResult(result, allowMissing = false) {
  assert.ok(!result.error, 'npm registry lookup did not complete');
  let value;
  try { value = JSON.parse(result.stdout); } catch { throw new Error('npm registry returned invalid JSON'); }
  if (result.status !== 0) {
    if (allowMissing && value.error?.code === 'E404') return null;
    throw new Error('npm registry lookup failed: ' + (value.error?.code ?? result.status));
  }
  return value;
}

function npmView(fields, allowMissing = false) {
  return npmResult(spawnSync('npm', ['view', ...fields, '--json', '--registry=https://registry.npmjs.org', '--prefer-online', '--fetch-retries=0', '--fetch-timeout=30000'], {
    encoding: 'utf8', timeout: 45000
  }), allowMissing);
}

async function registryPackage(name, version) {
  const metadata = npmView([name, 'name', 'dist-tags'], true);
  if (!metadata) return null;
  const integrity = npmView([name + '@' + version, 'dist.integrity'], true);
  assert.ok(integrity === null || (typeof integrity === 'string' && integrity.startsWith('sha512-')), 'Registry integrity is missing');
  return { ...metadata, versions: integrity === null ? {} : { [version]: { dist: { integrity } } } };
}

function existingImage(repository, version, revision) {
  const reference = repository + ':' + version;
  const result = spawnSync('docker', ['buildx', 'imagetools', 'inspect', reference], { encoding: 'utf8', timeout: 120000 });
  if (result.status !== 0) {
    assert.ok(!result.error && (/manifest unknown|no such manifest/i.test(result.stderr) || result.stderr.includes(reference + ': not found')) && !/unauthorized|forbidden|denied/i.test(result.stderr), 'Image registry check failed: ' + reference);
    return null;
  }
  const digest = /^Digest:\s+(sha256:[a-f0-9]{64})$/m.exec(result.stdout)?.[1];
  assert.ok(digest, 'Cannot determine existing image digest');
  execFileSync('docker', ['pull', '--platform', 'linux/amd64', repository + '@' + digest], { stdio: 'inherit', timeout: 180000 });
  const labels = JSON.parse(execFileSync('docker', ['image', 'inspect', repository + '@' + digest, '--format', '{{json .Config.Labels}}'], { encoding: 'utf8' }));
  assert.equal(labels['org.opencontainers.image.version'], version, 'Existing image version differs');
  assert.equal(labels['org.opencontainers.image.revision'], revision, 'Existing image was built from another commit');
  assert.equal(labels['org.opencontainers.image.source'], 'https://github.com/EnvarAI/EnvarPay', 'Existing image source differs');
  return { reference: repository + '@' + digest, digest };
}

async function run() {
  const pkg = JSON.parse(readFileSync(new URL('../packages/typescript/package.json', import.meta.url), 'utf8'));
  validateVersion(pkg.version);
  output('version', pkg.version);
  if (['check-npm', 'verify-npm'].includes(process.argv[2])) {
    const directory = process.argv[3];
    assert.ok(directory, 'Provide the verified package artifact directory');
    const files = readdirSync(directory).filter(name => name.endsWith('.tgz'));
    assert.equal(files.length, 1, 'Expected one tested npm tarball');
    const tarball = readFileSync(join(directory, files[0]));
    const integrity = 'sha512-' + createHash('sha512').update(tarball).digest('base64');
    if (process.argv[2] === 'verify-npm') {
      await waitForNpmPublication(() => registryPackage(pkg.name, pkg.version), pkg.name, pkg.version, integrity);
      output('npm_publish', false);
    } else output('npm_publish', npmPublication(await registryPackage(pkg.name, pkg.version), pkg.name, pkg.version, integrity));
  } else if (['check-images', 'verify-images'].includes(process.argv[2])) {
    assert.match(process.env.GITHUB_SHA ?? '', /^[a-f0-9]{40}$/, 'Use the tested source commit');
    const repositories = ['ghcr.io/envarai/envarpay', 'ghcr.io/envarai/envarpay-commerce'];
    const images = repositories.map(repository => existingImage(repository, pkg.version, process.env.GITHUB_SHA));
    if (process.argv[2] === 'verify-images') assert.ok(images.every(Boolean), 'Both versioned images must be published');
    if (images.every(Boolean)) {
      assert.equal(images[0].digest, images[1].digest, 'Image aliases must identify the same artifact');
      output('image_state', 'complete');
    } else if (images.some(Boolean)) {
      output('image_state', 'copy');
      output('image_source', images.find(Boolean).reference);
      output('image_target', repositories[images.findIndex(image => !image)] + ':' + pkg.version);
    } else output('image_state', 'new');
  } else throw new Error('Use check-npm or check-images');
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await run();
