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

const fixtureDir = fileURLToPath(new URL('./fixtures/bin-tool/', import.meta.url));
const manifestFile = path.join(fixtureDir, 'decx-binprobe.json');
const argvProgram = 'console.log(JSON.stringify(process.argv.slice(1)))';

function binaryManifest(): ToolManifest {
  const { manifest, errors } = validateManifest(JSON.parse(fs.readFileSync(manifestFile, 'utf8')), manifestFile, 'binprobe');
  assert.deepEqual(errors, []);
  assert.ok(manifest);
  return manifest;
}

test('binary fixture downloads a verified native executable and runs through decx -m', async (t) => {
  const platform = currentPlatformKey();
  assert.ok(platform, 'the integration test requires a supported platform');
  const home = tempDir('decx-bin-home-');
  const repoRoot = tempDir('decx-bin-repo-');
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });
  const subprojects = path.join(repoRoot, 'subprojects');
  const subproject = path.join(subprojects, 'decx-binprobe');
  fs.mkdirSync(subproject, { recursive: true });
  fs.copyFileSync(manifestFile, path.join(subproject, 'decx-binprobe.json'));

  // Repackage the test host's real native Node executable. No compiler or
  // checked-in architecture-specific binaries are needed to test bin launch.
  const entryName = process.platform === 'win32' ? 'binprobe.exe' : 'binprobe';
  const version = process.versions.node;
  const asset = `binprobe-${version}-${platform}.zip`;
  const archive = makeZip([{ name: `package/${entryName}`, data: fs.readFileSync(process.execPath), mode: 0o755 }]);
  const releasePath = `/acme/binprobe/releases/download/v${version}/`;
  const server = await startFixtureServer({
    [`${releasePath}${asset}`]: archive,
    [`${releasePath}SHA256SUMS`]: `${sha256(archive)}  ${asset}\n`,
  });
  try {
    const linkDir = path.join(home, 'links');
    const result = await installTool(binaryManifest(), { version, links: linkDir }, {
      home,
      repoRoot,
      env: { ...process.env, HOME: home, USERPROFILE: home },
      apiBase: server.url,
      downloadBase: server.url,
      log: () => {},
    });
    assert.equal(result.method, 'release download');
    assert.equal(result.checksum, `verified (${sha256(archive)})`);
    assert.equal(result.provenance.reported_version, process.version);
    assert.equal(path.basename(result.launcher), entryName);
    assert.ok(fs.existsSync(result.launcher));
    const linked = path.join(linkDir, process.platform === 'win32' ? 'binprobe.cmd' : entryName);
    assert.ok(fs.existsSync(linked));
    if (process.platform !== 'win32') {
      const viaLink = spawnSync(linked, ['-e', argvProgram, '--', 'from PATH'], { encoding: 'utf8' });
      assert.equal(viaLink.status, 0, viaLink.stderr);
      assert.deepEqual(JSON.parse(viaLink.stdout.trim()), ['from PATH']);
    }

    const args = ['two words', '中文', '--home', 'a"b'];
    const invoked = runCli(['--home', home, '--subprojects', subprojects, '-m', 'binprobe', '-e', argvProgram, '--', ...args], {
      HOME: home,
      USERPROFILE: home,
    });
    assert.equal(invoked.status, 0, invoked.stderr);
    assert.deepEqual(JSON.parse(invoked.stdout.trim()), args);
    assert.ok(server.requested.includes(`${releasePath}${asset}`));
    assert.ok(server.requested.includes(`${releasePath}SHA256SUMS`));
  } finally {
    await server.close();
  }
});
