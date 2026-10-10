import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { makeTarGz, makeZip, runCli, runCliAsync, sha256, startFixtureServer, tempDir } from './fixtures.ts';

const fixture = fileURLToPath(new URL('./fixtures/js-tool/', import.meta.url));
for (const format of ['tar.gz', 'zip']) {
  test(`CLI installs and executes a real JS package from ${format}, then refuses a broken replacement`, async t => {
    const root = tempDir('decx-js-functional-');
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const home = path.join(root, '安装目录');
    const thirdParty = path.join(root, 'third_party');
    const project = path.join(thirdParty, 'decx-jsprobe');
    fs.mkdirSync(project, { recursive: true });
    const manifest = JSON.parse(fs.readFileSync(path.join(fixture, 'decx-jsprobe.json'), 'utf8'));
    manifest.release.asset = `jsprobe-{version}.${format}`;
    fs.writeFileSync(path.join(project, 'decx-jsprobe.json'), JSON.stringify(manifest));
    const entries = [
      { name: 'package/package.json', data: '{"type":"module"}' },
      { name: 'package/jsprobe.js', data: fs.readFileSync(path.join(fixture, 'jsprobe.js')) },
      { name: 'package/render.js', data: fs.readFileSync(path.join(fixture, 'render.js')) },
    ];
    const pack = format === 'zip' ? makeZip : makeTarGz;
    const valid = pack(entries);
    const broken = pack([{ name: 'package/README.md', data: 'missing entrypoint' }]);
    const routes: Record<string, Buffer | string> = {};
    for (const [version, bytes] of [['1.0.0', valid], ['1.1.0', broken]] as const) {
      const base = `/acme/jsprobe/releases/download/v${version}`;
      const name = `jsprobe-${version}.${format}`;
      routes[`${base}/${name}`] = bytes;
      routes[`${base}/SHA256SUMS`] = `${sha256(bytes)}  ${name}\n`;
    }
    const server = await startFixtureServer(routes);
    t.after(() => server.close());
    const env = { HOME: root, USERPROFILE: root, DECX_GITHUB_DOWNLOAD_BASE: server.url };
    const execute = (args: string[]) => runCliAsync(['--home', home, '--third-party', thirdParty, ...args], env);
    const installed = await execute(['install', 'jsprobe', '--version', '1.0.0', '--no-links']);
    assert.equal(installed.status, 0, installed.stdout + installed.stderr);
    const args = ['two words', '中文', '--home', 'a"b', '&', '%PATH%', '!x!'];
    const invoked = runCli(['--home', home, '--third-party', thirdParty, '-m', 'jsprobe', ...args], env);
    assert.equal(invoked.status, 0, invoked.stderr);
    assert.deepEqual(JSON.parse(invoked.stdout), args);
    const provenance = path.join(home, 'share/jsprobe/PROVENANCE');
    const before = fs.readFileSync(provenance);
    const replaced = await execute(['update', 'jsprobe', '--version', '1.1.0', '--no-links']);
    assert.notEqual(replaced.status, 0);
    assert.match(replaced.stdout, /ASSET_LAYOUT/);
    assert.deepEqual(fs.readFileSync(provenance), before);
    const stillWorks = runCli(['--home', home, '--third-party', thirdParty, '-m', 'jsprobe', ...args], env);
    assert.equal(stillWorks.status, 0, stillWorks.stderr);
    assert.deepEqual(JSON.parse(stillWorks.stdout), args);
    const removed = await execute(['remove', 'jsprobe']);
    assert.equal(removed.status, 0, removed.stdout);
    assert.equal(fs.existsSync(provenance), false);
  });
}
