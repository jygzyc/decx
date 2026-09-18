import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadManifests, releaseAssetFor, supportedPlatforms, validateManifest } from '../src/manifest.ts';
import type { PlatformKey } from '../src/platform.ts';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'decx-manifest-'));
}

test('validateManifest accepts a minimal binary manifest', () => {
  const { manifest, errors } = validateManifest({
    manifest: 1,
    id: 'kuna',
    kind: 'binary',
    summary: 'decompiler',
    bins: ['kuna'],
    release: { repository: 'Noelo-Lab/kuna', assets: { 'linux-x64': 'kuna-{version}-linux-x86_64.tar.gz' } },
  });
  assert.deepEqual(errors, []);
  assert.equal(manifest?.id, 'kuna');
});

test('validateManifest rejects the shapes the CLI cannot install', () => {
  assert.match(validateManifest({ manifest: 2, id: 'x', kind: 'binary', summary: 's' }).errors[0] ?? '', /manifest/);
  assert.match(
    validateManifest({ manifest: 1, id: 'x', kind: 'binary', summary: 's' }).errors.join(' '),
    /needs a "release" or "source" block/,
  );
  assert.match(
    validateManifest({ manifest: 1, id: 'x', kind: 'python-venv', summary: 's' }).errors.join(' '),
    /needs a "python" block/,
  );
  assert.match(
    validateManifest({
      manifest: 1,
      id: 'x',
      kind: 'binary',
      summary: 's',
      release: { repository: 'nope', assets: {} },
    }).errors.join(' '),
    /owner\/repo/,
  );
  assert.match(
    validateManifest({
      manifest: 1,
      id: 'x',
      kind: 'binary',
      summary: 's',
      release: { repository: 'o/r', assets: { 'linux-x64': 'x.tar.gz' } },
    }).errors.join(' '),
    /needs a "bins" list/,
  );
  assert.match(
    validateManifest({
      manifest: 1,
      id: 'x',
      kind: 'binary',
      summary: 's',
      bins: ['kuna', ''],
      source: { path: 'subprojects/x' },
    }).errors.join(' '),
    /bins must be a list of non-empty strings/,
  );
});

test('loadManifests skips broken manifests without failing the others', () => {
  const dir = tempDir();
  const good = path.join(dir, 'afe');
  fs.mkdirSync(good, { recursive: true });
  fs.writeFileSync(
    path.join(good, 'decx-afe.json'),
    JSON.stringify({
      manifest: 1,
      id: 'afe',
      kind: 'binary',
      summary: 'framework tool',
      bins: ['afe'],
      source: { path: 'subprojects/decx-afe' },
    }),
  );
  const broken = path.join(dir, 'broken');
  fs.mkdirSync(broken, { recursive: true });
  fs.writeFileSync(path.join(broken, 'decx-broken.json'), '{ not json');
  const renamed = path.join(dir, 'renamed');
  fs.mkdirSync(renamed, { recursive: true });
  fs.writeFileSync(
    path.join(renamed, 'decx-renamed.json'),
    JSON.stringify({ manifest: 1, id: 'other', kind: 'binary', summary: 's', bins: ['other'], source: { path: 'subprojects/x' } }),
  );

  const { tools, issues } = loadManifests(dir);
  assert.deepEqual(
    tools.map((tool) => tool.id),
    ['afe'],
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

test('supportedPlatforms and releaseAssetFor read the release block', () => {
  const { manifest } = validateManifest({
    manifest: 1,
    id: 'kuna',
    kind: 'binary',
    summary: 'decompiler',
    bins: ['kuna'],
    release: {
      repository: 'Noelo-Lab/kuna',
      version: '1.508',
      assets: { 'macos-arm64': 'kuna-v{version}-macos-arm64.tar.gz' },
    },
  });
  assert.ok(manifest);
  assert.deepEqual(supportedPlatforms(manifest), ['macos-arm64']);
  assert.equal(releaseAssetFor(manifest, 'macos-arm64'), 'kuna-v1.508-macos-arm64.tar.gz');
  assert.equal(releaseAssetFor(manifest, 'linux-x64'), null);
});

test('source-only manifests install anywhere', () => {
  const { manifest } = validateManifest({
    manifest: 1,
    id: 'afe',
    kind: 'binary',
    summary: 'framework tool',
    bins: ['afe'],
    source: { path: 'subprojects/decx-afe', build: { manifest: 'Cargo.toml', packages: ['afe'] } },
  });
  assert.ok(manifest);
  assert.deepEqual(supportedPlatforms(manifest), ['any']);
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
    if (tool.id === 'kuna') {
      // The release archive is the only way in, and it exists for these hosts.
      assert.equal(tool.kind, 'binary');
      assert.deepEqual(supportedPlatforms(tool), ['linux-arm64', 'linux-x64', 'macos-arm64', 'macos-x64', 'windows-x64']);
    }
    if (tool.release !== undefined) {
      // Upstream renames assets between releases (Kuna added a `v` in 1.508),
      // so a name must stay templated on the version or the pin silently rots.
      const platforms = supportedPlatforms(tool).filter((platform) => platform !== 'any') as PlatformKey[];
      for (const platform of platforms) {
        assert.match(
          tool.release.assets?.[platform] ?? '',
          /\{version\}/,
          `${tool.id} ${platform} asset name carries {version}`,
        );
      }
      const first = platforms[0];
      if (first !== undefined) {
        assert.ok(releaseAssetFor(tool, first) !== null, `${tool.id} resolves an asset for ${first}`);
      }
    }
    if (tool.kind === 'python-venv') {
      assert.ok(tool.python !== undefined, `${tool.id} describes its python payload`);
    } else {
      assert.ok(tool.release !== undefined || tool.source !== undefined, `${tool.id} has a way in`);
    }
  }
});
