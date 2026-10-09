import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { HOST_PLATFORM, makeTarGz, makeZip, runCli, runCliAsync, sha256, startFixtureServer, tempDir } from './fixtures.ts';

// Only public CLI subprocesses. No imported manager functions or builtin mocks.
test('CLI discovery, usage, manifest errors and explicit home operate as user commands', async t => {
  const root = tempDir('decx-commands-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { HOME: root, USERPROFILE: root, DECX_HOME: path.join(root, '安装目录') };
  for (const command of ['version', '--version']) {
    const result = runCli([command], env);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.equal((result.json as { ok: boolean }).ok, true);
  }
  const help = runCli(['--help'], env);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /install/);
  for (const args of [['-m'], ['-m', 'unknown'], ['install'], ['install', 'unknown'], ['--home'], ['remove']]) {
    const result = runCli(args, env);
    assert.equal(result.status, 2, JSON.stringify(args) + result.stdout);
    assert.equal((result.json as { ok: boolean }).ok, false);
  }
  const pretty = runCli(['--pretty', 'version'], env);
  assert.equal(pretty.status, 0);
  assert.match(pretty.stdout, /\n  /);
  const projects = path.join(root, 'subprojects');
  fs.mkdirSync(path.join(projects, 'decx-broken'), { recursive: true });
  fs.writeFileSync(path.join(projects, 'decx-broken/decx-broken.json'), '{broken');
  const broken = runCli(['--subprojects', projects, 'install', 'broken'], env);
  assert.notEqual(broken.status, 0);
  assert.equal(fs.existsSync(path.join(env.DECX_HOME, 'bin')), false);
  const missing = runCli(['update', 'kuna'], env);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stdout, /NOT_INSTALLED/);
});

for (const format of ['zip', 'tar.gz']) {
  test(`CLI ${format}: real native payload, links, update, integrity and extraction failures preserve working install`, async t => {
    const root = tempDir('decx-install-');
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const home = path.join(root, '安装目录 with spaces');
    const links = path.join(root, 'links');
    const projects = path.join(root, 'subprojects');
    const name = process.platform === 'win32' ? 'probe.exe' : 'probe';
    const project = path.join(projects, 'decx-probe');
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, 'decx-probe.json'), JSON.stringify({
      manifest: 2, id: 'probe', summary: 'real native payload', install: ['github-release'],
      launch: { type: 'bin', commands: ['probe'] }, verify: '--version',
      release: { repository: 'acme/probe', tagPrefix: 'v', asset: `probe-{version}.${format}`, checksums: 'SHA256SUMS' },
    }));
    const bytes = fs.readFileSync(process.execPath); // Actual host executable, never an echo shell substitute.
    const pack = format === 'zip' ? makeZip : makeTarGz;
    const valid = pack([{ name: `package/${name}`, data: bytes, mode: 0o755 }]);
    const traversal = pack([{ name: '../escaped', data: 'must not be written' }]);
    const version = process.versions.node;
    const routes: Record<string, Buffer | string> = {
      '/repos/acme/probe/releases': JSON.stringify([{ tag_name: `v${version}`, draft: false, prerelease: false }]),
    };
    for (const version of [process.versions.node, '2.0.0', '3.0.0', '4.0.0', '5.0.0']) {
      const base = `/acme/probe/releases/download/v${version}`;
      const asset = `probe-${version}.${format}`;
      const archive = version === '3.0.0' ? traversal : valid;
      routes[`${base}/${asset}`] = archive;
      if (version !== '4.0.0') routes[`${base}/SHA256SUMS`] = `${version === '2.0.0' ? '0'.repeat(64) : sha256(archive)}  ${asset}\n`;
    }
    const releases = await startFixtureServer({ '/stable': routes['/repos/acme/probe/releases']! });
    t.after(() => releases.close());
    const server = await startFixtureServer(routes, { '/repos/acme/probe/releases': 302 }, {
      '/repos/acme/probe/releases': { location: `${releases.url}/stable` },
    });
    t.after(() => server.close());
    const env = { HOME: root, USERPROFILE: root, GITHUB_TOKEN: 'test-only-token', DECX_GITHUB_API_BASE: server.url, DECX_GITHUB_DOWNLOAD_BASE: server.url };
    const execute = (args: string[]) => runCliAsync(['--home', home, '--subprojects', projects, ...args], env);
    const installed = await execute(['install', 'probe', '--version', version, '--links', links]);
    assert.equal(installed.status, 0, installed.stdout + installed.stderr);
    const provenance = path.join(home, 'share/probe/PROVENANCE');
    assert.ok(fs.readFileSync(provenance, 'utf8').includes(`release_tag: v${version}`));
    const linked = path.join(links, process.platform === 'win32' ? 'probe.cmd' : 'probe');
    assert.ok(fs.existsSync(linked));
    const args = ['中文 路径', 'a"b', '&', '|', '%PATH%', '!x!', '--home', ''];
    const program = 'console.log(JSON.stringify(process.argv.slice(1))); process.exit(7)';
    const invoke = () => execute(['-m', 'probe', '-e', program, '--', ...args]);
    const invoked = await invoke();
    assert.equal(invoked.status, 7, invoked.stderr);
    assert.deepEqual(JSON.parse(invoked.stdout), args);
    const duplicate = await execute(['install', 'probe', '--version', version, '--links', links]);
    assert.notEqual(duplicate.status, 0);
    assert.match(duplicate.stdout, /ALREADY_INSTALLED/);
    const obsolete = path.join(home, 'share/probe/obsolete');
    fs.writeFileSync(obsolete, 'old payload');
    const updated = await execute(['update', 'probe', '--links', links]);
    assert.equal(updated.status, 0, updated.stdout + updated.stderr);
    assert.deepEqual(releases.authorizations, [undefined], 'CLI must not leak authentication across redirect origins');
    assert.equal(fs.existsSync(obsolete), false);
    assert.ok(fs.readFileSync(provenance, 'utf8').includes(`release_tag: v${version}`));
    const before = fs.readFileSync(provenance);
    for (const version of ['2.0.0', '3.0.0', '4.0.0', '5.0.0']) {
      const rejected = await execute(['update', 'probe', '--version', version, '--links', links]);
      assert.notEqual(rejected.status, 0, `Bad release ${version} must fail`);
      assert.deepEqual(fs.readFileSync(provenance), before);
      const retained = await invoke();
      assert.equal(retained.status, 7, retained.stderr);
      assert.deepEqual(JSON.parse(retained.stdout), args);
    }
    assert.equal(fs.existsSync(path.join(home, 'escaped')), false);
    const unrelated = path.join(home, 'bin/unrelated');
    fs.writeFileSync(unrelated, 'keep');
    const removed = await execute(['remove', 'probe']);
    assert.equal(removed.status, 0, removed.stdout);
    assert.equal(fs.existsSync(provenance), false);
    assert.equal(fs.existsSync(linked), false);
    assert.equal(fs.readFileSync(unrelated, 'utf8'), 'keep');
    assert.notEqual((await invoke()).status, 7);
    assert.match(HOST_PLATFORM, /^(darwin|linux|win)-(amd64|arm64)$/);
  });
}
