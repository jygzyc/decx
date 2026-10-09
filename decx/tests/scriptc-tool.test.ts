import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { installTool } from '../src/install.ts';
import { validateManifest, type ToolManifest } from '../src/manifest.ts';
import { currentPlatformKey } from '../src/platform.ts';
import { makeZip, runCli, sha256, startFixtureServer, tempDir } from './fixtures.ts';

const fixture = fileURLToPath(new URL('./fixtures/scriptc-tool/', import.meta.url));
const manifestFile = path.join(fixture, 'decx-scriptcprobe.json');
const compiler = fileURLToPath(new URL('../.scriptc-toolchain/bin/scriptc.exe', import.meta.url));
const supported = Number(process.versions.node.split('.')[0]) >= 24 &&
  !(process.platform === 'win32' && process.arch === 'arm64') &&
  fs.existsSync(compiler);

function manifest(): ToolManifest {
  const { manifest: parsed, errors } = validateManifest(JSON.parse(fs.readFileSync(manifestFile, 'utf8')), manifestFile, 'scriptcprobe');
  assert.deepEqual(errors, []);
  assert.ok(parsed);
  return parsed;
}

test('scriptc builds an independent TS tool; decx installs its verified native release', { skip: !supported }, async (t) => {
  const platform = currentPlatformKey();
  assert.ok(platform);
  const home = tempDir('decx-scriptc-home-');
  const repoRoot = tempDir('decx-scriptc-repo-');
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });
  const subprojects = path.join(repoRoot, 'subprojects');
  const project = path.join(subprojects, 'decx-scriptcprobe');
  fs.mkdirSync(project, { recursive: true });
  fs.copyFileSync(manifestFile, path.join(project, 'decx-scriptcprobe.json'));

  const executable = process.platform === 'win32' ? 'scriptcprobe.exe' : 'scriptcprobe';
  const compiled = path.join(repoRoot, executable);
  const build = spawnSync(compiler, ['build', path.join(fixture, 'probe.ts'), '-o', compiled], {
    encoding: 'utf8',
    timeout: 180_000,
  });
  assert.equal(build.status, 0, `${build.error ?? ''}\n${build.stdout}\n${build.stderr}`);
  const direct = spawnSync(compiled, ['--version'], {
    cwd: home, encoding: 'utf8',
    env: { ...process.env, PATH: home, Path: home, HOME: home, USERPROFILE: home },
  });
  assert.equal(direct.status, 0, direct.stderr);
  assert.equal(direct.stdout.trim(), 'scriptcprobe 1.0.0');

  const asset = `scriptcprobe-1.0.0-${platform}.zip`;
  const archive = makeZip([{ name: `package/${executable}`, data: fs.readFileSync(compiled), mode: 0o755 }]);
  const releasePath = '/acme/scriptcprobe/releases/download/v1.0.0/';
  const server = await startFixtureServer({
    [`${releasePath}${asset}`]: archive,
    [`${releasePath}SHA256SUMS`]: `${sha256(archive)}  ${asset}\n`,
  });
  try {
    const result = await installTool(manifest(), { version: '1.0.0', noLinks: true }, {
      home, repoRoot, env: { ...process.env, HOME: home, USERPROFILE: home },
      apiBase: server.url, downloadBase: server.url, log: () => {},
    });
    assert.equal(result.method, 'release download');
    assert.equal(result.provenance.reported_version, 'scriptcprobe 1.0.0');
    assert.equal(result.checksum, `verified (${sha256(archive)})`);
    const args = ['two words', '中文', '--home', 'a"b'];
    const launched = runCli(['--home', home, '--subprojects', subprojects, '-m', 'scriptcprobe', ...args], {
      HOME: home, USERPROFILE: home,
    });
    assert.equal(launched.status, 0, launched.stderr);
    assert.deepEqual(JSON.parse(launched.stdout.trim()), args);
    assert.ok(server.requested.includes(`${releasePath}${asset}`));
  } finally {
    await server.close();
  }
});
