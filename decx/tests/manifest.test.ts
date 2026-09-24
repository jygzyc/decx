import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DEFAULT_RELEASE_REPOSITORY, loadManifests, releaseAssetFor, supportedPlatforms, validateManifest } from '../src/manifest.ts';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'decx-manifest-'));
}

test('a minimal manifest derives everything the convention provides', () => {
  const { manifest, errors } = validateManifest(
    {
      manifest: 2,
      summary: 'decompiler',
      bins: ['kuna'],
      release: { asset: 'kuna-{version}-{os}-{arch}.tar.gz' },
    },
    'decx-kuna.json',
    'kuna',
  );
  assert.deepEqual(errors, []);
  assert.equal(manifest?.id, 'kuna');
  assert.equal(manifest?.kind, 'binary');
  assert.equal(manifest?.release.repository, DEFAULT_RELEASE_REPOSITORY);
  assert.equal(manifest?.release.tagPrefix, 'kuna-v');
  assert.equal(manifest?.release.checksums, 'kuna-SHA256SUMS.txt');
  assert.equal(manifest?.launch, undefined); // defaults to the first bins entry
  assert.deepEqual(supportedPlatforms(manifest!), [
    'win-amd64',
    'win-arm64',
    'darwin-amd64',
    'darwin-arm64',
    'linux-amd64',
    'linux-arm64',
  ]);
  assert.equal(releaseAssetFor(manifest!, 'darwin-arm64'), 'kuna-{version}-darwin-arm64.tar.gz');
});

test('a python block is what makes a tool python-venv', () => {
  const { manifest, errors } = validateManifest(
    {
      manifest: 2,
      summary: 'apk analyzer',
      python: { entry: 'main.py', requirements: 'requirements.txt' },
      release: { asset: 'droidasc-{version}-source.tar.gz' },
    },
    'decx-droidasc.json',
    'droidasc',
  );
  assert.deepEqual(errors, []);
  assert.equal(manifest?.kind, 'python-venv');
  assert.deepEqual(manifest?.python?.payload, ['droidasc']);
  assert.equal(manifest?.python?.venv, '.venv', 'the environment directory defaults to .venv');
  assert.deepEqual(supportedPlatforms(manifest!), ['any']);
  assert.equal(releaseAssetFor(manifest!, 'linux-amd64'), 'droidasc-{version}-source.tar.gz');
});

test('validateManifest rejects the shapes the CLI cannot install', () => {
  assert.match(validateManifest({ manifest: 1, id: 'x', summary: 's', bins: ['x'], release: { asset: 'x-{os}-{arch}.tgz' } }).errors[0] ?? '', /expected 2/);
  assert.match(
    validateManifest({ manifest: 2, id: 'x', summary: 's', bins: ['x'] }).errors.join(' '),
    /must be an object naming the release assets/,
  );
  // kind is derived, never declared.
  assert.match(
    validateManifest({ manifest: 2, id: 'x', kind: 'binary', summary: 's', bins: ['x'], release: { asset: 'x-{os}-{arch}.tgz' } }).errors.join(' '),
    /"kind" is derived/,
  );
  assert.match(
    validateManifest({ manifest: 2, id: 'x', summary: 's', release: { asset: 'x-{os}-{arch}.tgz' }, python: { entry: 'm.py', requirements: 'r.txt' }, bins: ['x'] }).errors.join(' '),
    /"bins" is only supported for binary tools/,
  );
  assert.match(
    validateManifest({ manifest: 2, id: 'x', summary: 's', bins: ['x'], release: { asset: 'x-{os}-{arch}.tgz' }, env: { A: '1' }, python: { entry: 'm.py', requirements: 'r.txt' } }).errors.join(' '),
    /env is only supported for binary tools/,
  );
  assert.match(
    validateManifest({ manifest: 2, id: 'x', summary: 's', bins: ['x'], release: { asset: '' } }).errors.join(' '),
    /non-empty asset template/,
  );
  assert.match(
    validateManifest({ manifest: 2, id: 'x', summary: 's', bins: ['x'], release: { repository: 'nope', asset: 'x-{os}-{arch}.tgz' } }).errors.join(' '),
    /owner\/repo/,
  );
  assert.match(
    validateManifest({ manifest: 2, id: 'x', summary: 's', bins: ['x'], release: { assets: { hobby: 'x.tgz' } } }).errors.join(' '),
    /not a platform key/,
  );
  assert.match(
    validateManifest({ manifest: 2, id: 'x', summary: 's', bins: ['x'], release: { asset: 'x-{os}-{arch}.tgz', assets: { any: 'x.tgz' } } }).errors.join(' '),
    /not both/,
  );
});

test('manifest 1 keys fail with pointers at their replacements', () => {
  const legacy = { manifest: 2, id: 'x', summary: 's', bins: ['x'], release: { asset: 'x-{os}-{arch}.tgz' } } as Record<string, unknown>;
  assert.match(
    validateManifest({ ...legacy, fallbackRelease: {} }).errors.join(' '),
    /"fallbackRelease" is not supported any more/,
  );
  assert.match(
    validateManifest({ ...legacy, source: { path: 'p' } }).errors.join(' '),
    /"source" is not supported any more/,
  );
  assert.match(
    validateManifest({ ...legacy, release: { asset: 'x-{os}-{arch}.tgz', version: '1.0.0' } }).errors.join(' '),
    /version is not supported any more/,
  );
  assert.match(
    validateManifest({ ...legacy, launch: { bin: 'x' } }).errors.join(' '),
    /launch must be the launcher name/,
  );
  assert.match(
    validateManifest({ ...legacy, verify: { args: ['--version'] } }).errors.join(' '),
    /verify must be the probe command/,
  );
  assert.match(
    validateManifest({ ...legacy, python: { entry: 'm.py', requirements: 'r.txt', path: 'p' } }).errors.join(' '),
    /python\.path is not supported any more/,
  );
  for (const venv of ['../outside', 'nested/venv', '', '.']) {
    assert.match(
      validateManifest({ ...legacy, python: { entry: 'm.py', requirements: 'r.txt', venv } }).errors.join(' '),
      /python\.venv must be a bare directory name/,
      `python.venv ${JSON.stringify(venv)} is rejected`,
    );
  }
});

test('Python paths reject traversal, absolute paths and shell syntax on every host', () => {
  const base = { manifest: 2, id: 'demo', summary: 's', release: { asset: 'source.tar.gz' } };
  for (const invalid of ['', '.', '..', '../x', 'a/../x', '/tmp/x', 'C:/x', 'C:x', 'a\\b', '//host/x', 'a//b', 'a\u0000b', 'a\nb', '$(id)', 'a"b', '%TEMP%', ' a']) {
    for (const field of ['entry', 'requirements', 'payload']) {
      const python = { entry: 'main.py', requirements: 'requirements.txt', payload: ['demo'], [field]: field === 'payload' ? [invalid] : invalid };
      const result = validateManifest({ ...base, python });
      assert.equal(result.manifest, undefined, `${field}: ${JSON.stringify(invalid)}`);
      assert.match(result.errors.join(' '), /safe relative path/);
    }
  }
  assert.deepEqual(validateManifest({ ...base, python: { entry: 'src/main.py', requirements: 'deps/requirements.txt', payload: ['src/my package'] } }).errors, []);
});

test('a manifest id that contradicts its directory is rejected', () => {
  assert.match(
    validateManifest({ manifest: 2, id: 'other', summary: 's', bins: ['x'], release: { asset: 'x-{os}-{arch}.tgz' } }, 'decx-x.json', 'x').errors.join(' '),
    /does not match directory "x"/,
  );
  assert.match(
    validateManifest({ manifest: 2, summary: 's', bins: ['x'], release: { asset: 'x-{os}-{arch}.tgz' } }).errors.join(' '),
    /missing "id"/,
  );
});

test('loadManifests skips broken manifests without failing the others', () => {
  const dir = tempDir();
  const good = path.join(dir, 'decx-good');
  fs.mkdirSync(good, { recursive: true });
  fs.writeFileSync(
    path.join(good, 'decx-good.json'),
    JSON.stringify({ manifest: 2, summary: 's', bins: ['good'], release: { asset: 'g-{version}-{os}-{arch}.tgz' } }),
  );
  const broken = path.join(dir, 'decx-broken');
  fs.mkdirSync(broken, { recursive: true });
  fs.writeFileSync(path.join(broken, 'decx-broken.json'), '{ not json');
  const renamed = path.join(dir, 'decx-renamed');
  fs.mkdirSync(renamed, { recursive: true });
  fs.writeFileSync(
    path.join(renamed, 'decx-renamed.json'),
    JSON.stringify({ manifest: 2, id: 'other', summary: 's', bins: ['x'], release: { asset: 'x-{os}-{arch}.tgz' } }),
  );

  const { tools, issues } = loadManifests(dir);
  assert.deepEqual(
    tools.map((tool) => tool.id),
    ['good'],
  );
  assert.equal(issues.length, 2);
  assert.match(issues.map((issue) => issue.message).join(' '), /invalid JSON/);
  assert.match(issues.map((issue) => issue.message).join(' '), /does not match directory/);
});

test('missing manifest directories are reported, not thrown', () => {
  const { tools, issues } = loadManifests(path.join(tempDir(), 'nope'));
  assert.deepEqual(tools, []);
  assert.equal(issues.length, 1);
});

test('the assets map handles per-platform names and the any fallback', () => {
  const { manifest } = validateManifest(
    {
      manifest: 2,
      summary: 'mixed names',
      bins: ['x'],
      release: {
        assets: {
          'linux-amd64': 'x-linux64-{version}.tgz',
          'darwin-arm64': 'x-mac-{version}.tgz',
          any: 'x-source-{version}.tgz',
        },
      },
    },
    'decx-x.json',
    'x',
  );
  assert.ok(manifest);
  assert.deepEqual(supportedPlatforms(manifest), ['any', 'darwin-arm64', 'linux-amd64']);
  assert.equal(releaseAssetFor(manifest, 'linux-amd64'), 'x-linux64-{version}.tgz');
  assert.equal(releaseAssetFor(manifest, 'win-amd64'), 'x-source-{version}.tgz');
});

/** The shipped tool list is the contract an agent sees; keep it loadable. */
test('the manifests in subprojects/ all load cleanly', () => {
  const dir = path.resolve(import.meta.dirname, '..', '..', 'subprojects');
  const { tools, issues } = loadManifests(dir);
  assert.deepEqual(issues, []);
  assert.deepEqual(
    tools.map((tool) => tool.id),
    ['afe', 'droidasc', 'kuna'],
  );
  for (const tool of tools) {
    assert.ok(tool.summary.length > 0, `${tool.id} has a summary`);
    assert.ok(supportedPlatforms(tool).length > 0, `${tool.id} declares where it installs`);
    if (tool.kind === 'python-venv') {
      assert.ok(tool.python !== undefined, `${tool.id} describes its python payload`);
    } else {
      assert.ok(tool.bins !== undefined && tool.bins.length > 0, `${tool.id} names its binaries`);
    }
    // Upstream renames assets between releases (Kuna added a `v` in 1.508),
    // so a name must stay templated on the version or the pin silently rots.
    for (const platform of supportedPlatforms(tool).filter((platform) => platform !== 'any')) {
      assert.match(
        releaseAssetFor(tool, platform as Parameters<typeof releaseAssetFor>[1]) ?? '',
        /\{version\}/,
        `${tool.id} ${os}-{arch} asset name carries {version}`,
      );
    }
  }
});
