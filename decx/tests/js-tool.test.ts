import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { installTool, InstallError } from '../src/install.ts';
import { validateManifest, type ToolManifest } from '../src/manifest.ts';
import { makeTarGz, makeZip, runCli, sha256, startFixtureServer, tempDir } from './fixtures.ts';

const fixtureDir = fileURLToPath(new URL('./fixtures/js-tool/', import.meta.url));
const manifestFile = path.join(fixtureDir, 'decx-jsprobe.json');
const scriptFile = path.join(fixtureDir, 'jsprobe.js');
const moduleFile = path.join(fixtureDir, 'render.js');

function archiveEntries() {
  return [
    { name: 'package/package.json', data: '{"type":"module"}' },
    { name: 'package/jsprobe.js', data: fs.readFileSync(scriptFile) },
    { name: 'package/render.js', data: fs.readFileSync(moduleFile) },
  ];
}
const releasePath = '/acme/jsprobe/releases/download/v1.0.0/';

function jsManifest(): ToolManifest {
  const { manifest, errors } = validateManifest(JSON.parse(fs.readFileSync(manifestFile, 'utf8')), manifestFile, 'jsprobe');
  assert.deepEqual(errors, []);
  assert.ok(manifest);
  return manifest;
}

function testContext(home: string, repoRoot: string, url: string) {
  return {
    home,
    repoRoot,
    apiBase: url,
    downloadBase: url,
    env: { ...process.env, HOME: home, USERPROFILE: home },
    log: () => {},
  };
}

async function withRelease<T>(asset: string, archive: Buffer, body: (url: string) => Promise<T>): Promise<T> {
  const server = await startFixtureServer({
    [`${releasePath}${asset}`]: archive,
    [`${releasePath}SHA256SUMS`]: `${sha256(archive)}  ${asset}\n`,
  });
  try {
    return await body(server.url);
  } finally {
    await server.close();
  }
}

test('JS fixture installs from a verified archive and executes through decx -m', async (t) => {
  const home = tempDir('decx-js-home-');
  const repoRoot = tempDir('decx-js-repo-');
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });
  const subproject = path.join(repoRoot, 'subprojects', 'decx-jsprobe');
  fs.mkdirSync(subproject, { recursive: true });
  fs.copyFileSync(manifestFile, path.join(subproject, 'decx-jsprobe.json'));
  const archive = makeTarGz(archiveEntries());
  await withRelease('jsprobe-1.0.0.tar.gz', archive, async (url) => {
    const linkDir = path.join(home, 'links');
    const result = await installTool(jsManifest(), { version: '1.0.0', links: linkDir }, testContext(home, repoRoot, url));
    assert.equal(result.method, 'release download');
    assert.equal(result.checksum, `verified (${sha256(archive)})`);
    assert.equal(result.provenance.reported_version, 'jsprobe 1.0.0');
    assert.ok(fs.existsSync(path.join(home, 'share', 'jsprobe', 'app', 'package', 'jsprobe.js')));
    assert.ok(fs.existsSync(path.join(home, 'share', 'jsprobe', 'app', 'package', 'render.js')));
    assert.ok(fs.existsSync(result.launcher));
    const linked = path.join(linkDir, process.platform === 'win32' ? 'jsprobe.cmd' : 'jsprobe');
    assert.ok(fs.existsSync(linked));
    if (process.platform !== 'win32') {
      const viaLink = spawnSync(linked, ['from PATH'], { encoding: 'utf8' });
      assert.equal(viaLink.status, 0, viaLink.stderr);
      assert.deepEqual(JSON.parse(viaLink.stdout.trim()), ['from PATH']);
    }
    const args = ['two words', '中文', '--home', 'a"b'];
    const invoked = runCli(['--home', home, '--subprojects', path.join(repoRoot, 'subprojects'), '-m', 'jsprobe', ...args], {
      HOME: home,
      USERPROFILE: home,
    });
    assert.equal(invoked.status, 0, invoked.stderr);
    assert.deepEqual(JSON.parse(invoked.stdout.trim()), args);
    const help = runCli(['--home', home, '--subprojects', path.join(repoRoot, 'subprojects'), '-m', 'jsprobe', '--help']);
    assert.equal(help.status, 0, help.stderr);
    assert.equal(help.stdout.trim(), 'usage: jsprobe [arguments...]');
  });
});

test('JS release generates a Windows cmd launcher from a zip asset', async (t) => {
  const home = tempDir('decx-js-win-');
  const repoRoot = tempDir('decx-js-repo-');
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });
  const manifest = jsManifest();
  manifest.release = { ...manifest.release!, asset: 'jsprobe-{version}.zip' };
  const archive = makeZip(archiveEntries());
  await withRelease('jsprobe-1.0.0.zip', archive, async (url) => {
    const result = await installTool(manifest, { version: '1.0.0', noLinks: true }, {
      ...testContext(home, repoRoot, url),
      platform: 'win-amd64',
    });
    assert.deepEqual(result.binaries, ['jsprobe.cmd']);
    assert.match(fs.readFileSync(result.launcher, 'utf8'), /node "%root%\\share\\jsprobe\\app\\package\\jsprobe\.js" %\*/);
  });
});

test('JS release without its declared script never commits an install', async (t) => {
  const home = tempDir('decx-js-missing-script-');
  const repoRoot = tempDir('decx-js-repo-');
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });
  const archive = makeTarGz([{ name: 'package/README.md', data: 'no entry point' }]);
  await withRelease('jsprobe-1.0.0.tar.gz', archive, async (url) => {
    await assert.rejects(
      installTool(jsManifest(), { version: '1.0.0', noLinks: true }, testContext(home, repoRoot, url)),
      (error: unknown) => error instanceof InstallError && error.code === 'ASSET_LAYOUT',
    );
  });
  assert.equal(fs.existsSync(path.join(home, 'share', 'jsprobe')), false);
  assert.equal(fs.existsSync(path.join(home, 'bin', 'jsprobe')), false);
});

test('JS install fails before downloading when Node is unavailable', async (t) => {
  const home = tempDir('decx-js-missing-node-');
  const repoRoot = tempDir('decx-js-repo-');
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });
  await assert.rejects(
    installTool(jsManifest(), { version: '1.0.0', noLinks: true }, {
      ...testContext(home, repoRoot, 'http://127.0.0.1:1'),
      env: { HOME: home, USERPROFILE: home, PATH: '' },
    }),
    (error: unknown) => error instanceof InstallError && error.code === 'NODE_NOT_FOUND',
  );
  assert.deepEqual(fs.readdirSync(home), []);
});
