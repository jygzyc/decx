import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DEFAULT_RELEASE_REPOSITORY, loadManifests, releaseAssetFor, supportedPlatforms, validateManifest } from '../src/manifest.ts';
import { SUBPROJECTS_DIR } from './fixtures.ts';

const sourceRelease = { asset: 'tool-{version}-source.tar.gz' };
const binaryRelease = { assets: { 'linux-amd64': 'tool-{version}-linux-amd64.tar.gz', 'win-amd64': 'tool-{version}-win-amd64.zip' } };
const binary = {
  manifest: 2, summary: 'native tool', install: ['github-release'],
  launch: { type: 'bin', commands: ['tool', 'helper'] }, release: binaryRelease,
};
const python = {
  manifest: 2, summary: 'Python tool', install: ['pip', 'install', '{source}'],
  launch: { type: 'python', commands: ['tool'] }, release: sourceRelease,
};
const pypi = {
  manifest: 2, summary: 'Python tool', install: ['pip', 'install', 'droidasc'],
  launch: { type: 'python', commands: ['droidasc'] },
};

test('bin launch derives the default command and all release executables', () => {
  const { manifest, errors } = validateManifest(binary, 'decx-tool.json', 'tool');
  assert.deepEqual(errors, []);
  assert.equal(manifest?.id, 'tool');
  assert.deepEqual(manifest?.install, ['github-release']);
  assert.deepEqual(manifest?.launch, { type: 'bin', commands: ['tool', 'helper'] });
  assert.equal(manifest?.release?.repository, DEFAULT_RELEASE_REPOSITORY);
  assert.equal(manifest?.release?.tagPrefix, 'tool-v');
  assert.equal(manifest?.release?.checksums, 'tool-SHA256SUMS.txt');
  assert.equal(validateManifest({ ...binary, release: { ...binaryRelease, checksums: null } }, 'decx-tool.json', 'tool').manifest?.release?.checksums, null);
  assert.deepEqual(supportedPlatforms(manifest!), ['linux-amd64', 'win-amd64']);
  assert.equal(releaseAssetFor(manifest!, 'linux-amd64'), 'tool-{version}-linux-amd64.tar.gz');
});

test('python launch lets DECX create the venv for a declared pip command', () => {
  const { manifest, errors } = validateManifest(python, 'decx-tool.json', 'tool');
  assert.deepEqual(errors, []);
  assert.deepEqual(manifest?.install, ['pip', 'install', '{source}']);
  assert.deepEqual(manifest?.launch, { type: 'python', commands: ['tool'] });
  assert.deepEqual(supportedPlatforms(manifest!), ['any']);
});

test('shipped manifests use one launch contract and explicit install recipes', () => {
  const { tools, issues } = loadManifests(SUBPROJECTS_DIR);
  assert.deepEqual(issues, []);
  assert.deepEqual(tools.map((tool) => tool.id), ['afe', 'droidasc', 'kuna']);
  assert.deepEqual(tools.find((tool) => tool.id === 'droidasc')?.install, ['pip', 'install', 'droidasc']);
  assert.equal(tools.find((tool) => tool.id === 'droidasc')?.release, undefined);
  assert.deepEqual(tools.find((tool) => tool.id === 'afe')?.install, ['github-release']);
  assert.deepEqual(tools.find((tool) => tool.id === 'kuna')?.install, ['github-release']);
  assert.deepEqual(tools.find((tool) => tool.id === 'kuna')?.launch.commands, ['kuna', 'decomp_dbg', 'slacomp']);
});

test('PyPI recipes need no release; source recipes and binaries do', () => {
  const { manifest, errors } = validateManifest(pypi, 'decx-droidasc.json', 'droidasc');
  assert.deepEqual(errors, []);
  assert.equal(manifest?.release, undefined);
  assert.match(validateManifest({ ...python, release: undefined }).errors.join(' '), /release: must be an object/);
  assert.match(validateManifest({ ...binary, release: undefined }).errors.join(' '), /release: must be an object/);
  assert.match(validateManifest({ ...pypi, release: sourceRelease }).errors.join(' '), /must not declare release assets/);
  assert.match(validateManifest({ ...pypi, install: ['pip', 'install', '--no-deps'] }).errors.join(' '), /must name a package/);
});

test('install is explicit and must match launch.type', () => {
  for (const invalid of [undefined, null, 'github-release', [], ['release'], ['sh', '-c', 'echo hi'], ['github-release', 'extra']]) {
    assert.equal(validateManifest({ ...binary, install: invalid }).manifest, undefined);
  }
  assert.match(validateManifest({ ...binary, install: null }).errors.join(' '), /non-empty argv array/);
  assert.match(validateManifest({ ...binary, install: ['pip', 'install', 'tool'] }).errors.join(' '), /bin\/js launch requires/);
  assert.match(validateManifest({ ...binary, launch: { type: 'js', commands: ['tool'] }, install: ['pip', 'install', 'tool'] }).errors.join(' '), /bin\/js launch requires/);
  assert.match(validateManifest({ ...python, install: ['github-release'] }).errors.join(' '), /python launch requires/);
  assert.match(validateManifest({ ...python, install: ['pip', 'install', ''] }).errors.join(' '), /non-empty argv array/);
  assert.match(validateManifest({ ...binary, bins: ['tool'] }).errors.join(' '), /"bins" is obsolete/);
  assert.match(validateManifest({ ...python, env: { X: 'x' } }).errors.join(' '), /env is only supported for bin tools/);
  assert.match(validateManifest({ ...binary, launch: { type: 'js', commands: ['tool'] }, env: { X: 'x' } }).errors.join(' '), /env is only supported for bin tools/);
});

test('launch owns the runtime and public commands, not a top-level bins list', () => {
  for (const launch of [undefined, 'tool', {}, { type: 'ruby', commands: ['tool'] }, { type: 'bin', commands: [] }]) {
    assert.equal(validateManifest({ ...binary, launch }).manifest, undefined);
  }
  for (const command of ['', '.', '../tool', 'tool/other', ' my tool']) {
    assert.match(validateManifest({ ...binary, launch: { type: 'bin', commands: [command] } }).errors.join(' '), /safe command names/);
  }
  assert.match(validateManifest({ ...binary, launch: { type: 'bin', commands: ['tool', 'tool'] } }).errors.join(' '), /distinct safe command names/);
  assert.match(validateManifest({ ...python, launch: { type: 'python', commands: ['tool', 'helper'] } }).errors.join(' '), /supports one console command/);
  assert.match(validateManifest({ ...binary, launch: { type: 'bin', commands: ['tool'], extra: true } }).errors.join(' '), /unknown field "extra"/);
  assert.match(validateManifest({ ...binary, launch: { type: 'ruby', commands: ['tool'] } }).errors.join(' '), /type must be "bin", "python" or "js"/);
  assert.equal(validateManifest({ ...binary, launch: { type: 'js', commands: ['tool'] } }, 'manifest', 'tool').manifest?.launch.type, 'js');
});

test('release rejects malformed or contradictory declarations', () => {
  assert.match(validateManifest({ ...binary, release: { asset: 'a', assets: { any: 'b' } } }).errors.join(' '), /not both/);
  assert.match(validateManifest({ ...binary, release: { assets: { hobby: 'x' } } }).errors.join(' '), /not a platform key/);
  assert.match(validateManifest({ ...binary, release: { repository: 'invalid', asset: 'x' } }).errors.join(' '), /owner\/repo/);
  assert.match(validateManifest({ ...binary, release: { asset: '' } }).errors.join(' '), /non-empty asset template/);
});

test('obsolete, unknown and mismatched fields fail', () => {
  for (const id of ['.', '..', 'bad name', 'Bad', 'bad/path']) {
    assert.match(validateManifest({ ...binary, id }, 'decx-tool.json').errors.join(' '), /id must be a safe lowercase tool name/);
  }
  assert.match(validateManifest({ ...binary, id: 3 }).errors.join(' '), /id must be a non-empty string/);
  assert.match(validateManifest({ ...binary, manifest: 1 }).errors.join(' '), /expected 2/);
  assert.match(validateManifest({ ...binary, kind: 'binary' }).errors.join(' '), /"kind" is derived from launch.type/);
  assert.match(validateManifest({ ...binary, python: {} }).errors.join(' '), /python is obsolete/);
  assert.match(validateManifest({ ...binary, source: {} }).errors.join(' '), /"source" is not supported/);
  assert.match(validateManifest({ ...binary, unexpected: true }).errors.join(' '), /unknown field "unexpected"/);
  assert.match(validateManifest({ ...binary, homepage: null }).errors.join(' '), /"homepage" must be a string/);
  assert.match(validateManifest({ ...binary, requires: { python: '>=3.10' } }).errors.join(' '), /only supported for Python tools/);
  assert.match(validateManifest({ ...binary, requires: { node: '24' } }).errors.join(' '), /requires has unknown field/);
  assert.match(validateManifest({ ...binary, release: { ...binaryRelease, unexpected: true } }).errors.join(' '), /release: unknown field/);
  assert.match(validateManifest({ ...binary, id: 'other' }, 'decx-tool.json', 'tool').errors.join(' '), /does not match directory/);
  assert.deepEqual(validateManifest({ ...binary, release: { ...binaryRelease, version: '1.0.0' } }, 'decx-tool.json', 'tool').errors, []);
  assert.match(validateManifest({ ...binary, release: { ...binaryRelease, version: '' } }).errors.join(' '), /version must be a non-empty/);
});

test('manifest discovery reports broken files without hiding valid tools', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'decx-manifest-'));
  try {
    const good = path.join(root, 'decx-good');
    const bad = path.join(root, 'decx-bad');
    fs.mkdirSync(good);
    fs.mkdirSync(bad);
    fs.writeFileSync(path.join(good, 'decx-good.json'), JSON.stringify({ ...binary, launch: { type: 'bin', commands: ['good'] } }));
    fs.writeFileSync(path.join(bad, 'decx-bad.json'), '{ invalid');
    const { tools, issues } = loadManifests(root);
    assert.deepEqual(tools.map((tool) => tool.id), ['good']);
    assert.equal(issues.length, 1);
    assert.match(issues[0]!.message, /invalid JSON/);
    assert.equal(loadManifests(path.join(root, 'missing')).issues.length, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
