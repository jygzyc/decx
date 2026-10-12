import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { HOST_PLATFORM, makeTarGz, makeZip, runCli, runCliAsync, sha256, startFixtureServer, tempDir, writeCatalog } from './fixtures.ts';

// Only public CLI subprocesses. No imported manager functions or builtin mocks.
test('CLI stages verified resources before verification and launches executable metadata and human shims identically', async t => {
  const root = tempDir('decx-resources-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, '安装目录 with spaces');
  const thirdParty = path.join(root, 'third_party');
  const name = process.platform === 'win32' ? 'resources.exe' : 'resources';
  const envKey = process.platform === 'win32' ? 'PATH' : 'Path';
  writeCatalog(thirdParty, [{
    repo: 'acme/resources', id: 'resources', summary: 'native executable with required resources', install: ['github-release'],
    launch: { type: 'bin', commands: ['resources'] },
    verify: "-e console.log(require('fs').readFileSync(process.env.RESOURCES+'/probe.sla','utf8'))",
    env: { RESOURCES: '{prefix}/specs', Path: 'descriptor-path', DECX_MARKER: '资源%literal!^&' },
    release: { asset: 'resources.zip', extraAssets: { specs: 'specs.zip' } },
  }]);
  const archive = makeZip([{ name, data: fs.readFileSync(process.execPath), mode: 0o755 }]);
  const specs = makeZip([{ name: 'specs/probe.sla', data: 'resource fixture' }]);
  const assets = [
    { name: 'resources.zip', digest: `sha256:${sha256(archive)}` },
    { name: 'specs.zip', digest: `sha256:${sha256(specs)}` },
  ];
  const releasePath = '/repos/acme/resources/releases/tags/v1.0.0';
  const routes: Record<string, string | Buffer> = {
    [releasePath]: JSON.stringify({ tag_name: 'v1.0.0', assets }),
    '/acme/resources/releases/download/v1.0.0/resources.zip': archive,
    '/acme/resources/releases/download/v1.0.0/specs.zip': specs,
  };
  const server = await startFixtureServer(routes);
  t.after(() => server.close());
  const env = { HOME: root, USERPROFILE: root, GITHUB_TOKEN: 'test-only-token', DECX_GITHUB_API_BASE: server.url, DECX_GITHUB_DOWNLOAD_BASE: server.url };
  const common = ['--home', home, '--third-party', thirdParty];
  const installed = await runCliAsync([...common, 'install', 'resources', '--version', 'v1.0.0', '--no-links'], env);
  assert.equal(installed.status, 0, installed.stderr + installed.stdout);
  assert.equal(server.requested.filter(url => url === releasePath).length, 1);
  const expected = [path.join(home, 'share/resources/specs'), 'descriptor-path', '资源%literal!^&'];
  const expression = `JSON.stringify([process.env.RESOURCES,process.env.${envKey},process.env.DECX_MARKER])`;
  const direct = runCli([...common, '-m', 'resources', '-p', expression], env);
  assert.equal(direct.status, 0, direct.stderr + direct.stdout);
  assert.deepEqual(JSON.parse(direct.stdout), expected);
  const launcher = (installed.json as { launcher: string }).launcher;
  const shim = process.platform === 'win32'
    ? spawnSync('cmd.exe', ['/d', '/s', '/c', `""${launcher}" -p "${expression}""`], { encoding: 'utf8', env: { ...process.env, ...env }, windowsVerbatimArguments: true })
    : spawnSync(launcher, ['-p', expression], { encoding: 'utf8', env: { ...process.env, ...env } });
  assert.equal(shim.status, 0, shim.stderr + shim.stdout);
  assert.deepEqual(JSON.parse(shim.stdout), expected);
  const provenance = path.join(home, 'share/resources/PROVENANCE');
  const record = fs.readFileSync(provenance);
  assets[1]!.digest = `sha256:${'0'.repeat(64)}`;
  routes[releasePath] = JSON.stringify({ tag_name: 'v1.0.0', assets });
  const rejected = await runCliAsync([...common, 'update', 'resources', '--version', 'v1.0.0'], env);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stdout, /CHECKSUM_MISMATCH/);
  assert.deepEqual(fs.readFileSync(provenance), record);
});
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
  const thirdParty = path.join(root, 'third_party');
  fs.mkdirSync(thirdParty, { recursive: true });
  fs.writeFileSync(path.join(thirdParty, 'tools.json'), '{broken');
  const broken = runCli(['--third-party', thirdParty, 'install', 'broken'], env);
  assert.notEqual(broken.status, 0);
  assert.equal(fs.existsSync(path.join(env.DECX_HOME, 'bin')), false);
  const missing = runCli(['update', 'kuna'], env);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stdout, /NOT_INSTALLED/);
});

test('CLI reads only the central catalog and keeps valid entries despite invalid or duplicate tools', async t => {
  const root = tempDir('decx-catalog-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const thirdParty = path.join(root, 'third_party');
  const env = { HOME: root, USERPROFILE: root, DECX_HOME: path.join(root, 'home') };
  const tool = (id: string) => ({
    repo: 'acme/catalog', id, summary: 'catalog fixture', install: ['github-release'],
    launch: { type: 'bin', commands: [id] }, verify: '-v',
    release: { tagPrefix: 'v', asset: 'catalog.zip', checksums: null },
  });
  const check = (id: string, code: string, status: number) => {
    const result = runCli(['--third-party', thirdParty, '-m', id], env);
    assert.equal(result.status, status, result.stderr + result.stdout);
    assert.equal((result.json as { error: { code: string } }).error.code, code);
    return result;
  };
  const { id: _id, ...missingId } = tool('implicit');
  writeCatalog(thirdParty, [
    tool('first'), { ...tool('broken'), launch: { type: 'invalid', commands: ['broken'] } },
    missingId, tool('second'), { ...tool('first'), launch: { type: 'bin', commands: ['duplicate'] } },
    null, { ...tool('schema-entry'), $schema: './decx-tool.schema.json' },
  ]);
  for (const id of ['first', 'second']) check(id, 'NOT_INSTALLED', 1);
  for (const id of ['broken', 'implicit', 'schema-entry']) check(id, 'UNKNOWN_TOOL', 2);
  const unknown = check('absent', 'UNKNOWN_TOOL', 2);
  assert.equal((unknown.json as { error: { hint: string } }).error.hint, 'known tools: first, second');
  // Both valid tools remain installable; a duplicate cannot replace the first
  // entry's executable metadata with a command absent from the archive.
  const archive = makeZip(['first', 'second'].map(id => ({
    name: process.platform === 'win32' ? `${id}.exe` : id,
    data: fs.readFileSync(process.execPath), mode: 0o755,
  })));
  const server = await startFixtureServer({
    '/repos/acme/catalog/releases/tags/v1.0.0': JSON.stringify({
      tag_name: 'v1.0.0', assets: [{ name: 'catalog.zip', digest: `sha256:${sha256(archive)}` }],
    }),
    '/acme/catalog/releases/download/v1.0.0/catalog.zip': archive,
  });
  t.after(() => server.close());
  const home = path.join(root, 'installed');
  const installEnv = { ...env, DECX_GITHUB_API_BASE: server.url, DECX_GITHUB_DOWNLOAD_BASE: server.url };
  for (const id of ['first', 'second']) {
    const installed = await runCliAsync(['--home', home, '--third-party', thirdParty,
      'install', id, '--version', 'v1.0.0', '--no-links'], installEnv);
    assert.equal(installed.status, 0, installed.stderr + installed.stdout);
    assert.equal((installed.json as { id: string }).id, id);
    const launched = runCli(['--home', home, '--third-party', thirdParty, '-m', id, '-v'], env);
    assert.equal(launched.status, 0, launched.stderr + launched.stdout);
    assert.equal(launched.stdout.trim(), process.version);
  }
  assert.equal(fs.existsSync(path.join(home, 'bin', process.platform === 'win32' ? 'duplicate.exe' : 'duplicate')), false);

  const file = path.join(thirdParty, 'tools.json');
  for (const catalog of [null, [], 'not an object', {}, { manifest: 1, tools: null }, { manifest: 1, tools: {} }, { manifest: 1, tools: [] },
    { manifest: 1, tools: [tool('first')], extra: true }, { manifest: 1, tools: [tool('first')], $schema: 'wrong' },
    { tools: [tool('first')] }, ...[0, 2, '1', null].map(manifest => ({ manifest, tools: [tool('first')] }))]) {
    fs.writeFileSync(file, JSON.stringify(catalog));
    check('first', 'UNKNOWN_TOOL', 2);
  }
  fs.writeFileSync(file, '{broken');
  check('first', 'UNKNOWN_TOOL', 2);
  fs.rmSync(file);
  // No fallback to per-directory manifests, even when those are otherwise valid.
  const old = path.join(thirdParty, 'decx-implicit');
  fs.mkdirSync(old);
  fs.writeFileSync(path.join(old, 'decx-implicit.json'), JSON.stringify(tool('implicit')));
  check('implicit', 'UNKNOWN_TOOL', 2);
  writeCatalog(thirdParty, [tool('second')]);
  check('implicit', 'UNKNOWN_TOOL', 2);
  check('second', 'NOT_INSTALLED', 1);
  assert.equal(fs.existsSync(path.join(env.DECX_HOME, 'share')), false);
});

test('catalog manifest 1 accepts inferred runtimes and empty env, and rejects old or mismatched contracts', t => {
  const root = tempDir('decx-contract-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const thirdParty = path.join(root, 'third_party');
  const env = { HOME: root, USERPROFILE: root, DECX_HOME: path.join(root, 'home') };
  const tool = { id: 'contract', repo: 'acme/contract', summary: 'contract fixture',
    install: ['github-release'], launch: { type: 'bin', commands: ['contract'] },
    release: { asset: 'contract-{version}.zip' } };
  const check = (entry: unknown, expected: string) => {
    writeCatalog(thirdParty, [entry]);
    const result = runCli(['--third-party', thirdParty, '-m', 'contract'], env);
    assert.equal((result.json as { error: { code: string } }).error.code, expected, result.stdout);
  };
  for (const type of ['bin', 'js', 'python']) {
    const entry = { ...tool, launch: { type, commands: ['contract'] }, env: {},
      ...(type === 'python' ? { install: ['pip', 'install', 'contract'], release: undefined } : {}) };
    check(entry, 'NOT_INSTALLED');
    check({ ...entry, requires: type }, 'NOT_INSTALLED');
    check({ ...entry, requires: type === 'bin' ? 'python' : 'bin' }, 'UNKNOWN_TOOL');
    if (type !== 'bin') check({ ...entry, env: { KEEP: 'must not be discarded' } }, 'UNKNOWN_TOOL');
  }
  for (const fields of [{ manifest: 2 }, { manifest: 1 }, { homepage: 'https://example.com' },
    { repo: undefined }, ...['', 'https://github.com/acme/contract', 'acme', 'acme/repo/path', '../repo', 'acme/white space'].map(repo => ({ repo })),
    { requires: { python: '>=3.10' } }, { requires: 'invalid' }, { release: { ...tool.release, repository: 'other/repo' } }]) {
    check({ ...tool, ...fields }, 'UNKNOWN_TOOL');
  }
  // The exact user catalog must expose all three tools without attempting installs.
  const actual = path.resolve(import.meta.dirname, '../../third_party');
  const unknown = runCli(['--third-party', actual, '-m', 'absent'], env);
  assert.equal((unknown.json as { error: { hint: string } }).error.hint, 'known tools: afe, droidasc, kuna');
  for (const id of ['afe', 'droidasc', 'kuna']) {
    const result = runCli(['--third-party', actual, '-m', id], env);
    assert.equal((result.json as { error: { code: string } }).error.code, 'NOT_INSTALLED');
  }
});

test('generic stable discovery matches versioned host and extra assets, with mandatory default REST digests', async t => {
  const root = tempDir('decx-mixed-releases-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const thirdParty = path.join(root, 'third_party');
  const [os, arch] = HOST_PLATFORM.split('-');
  const name = process.platform === 'win32' ? 'payload.exe' : 'payload';
  const archive = makeZip([{ name, data: fs.readFileSync(process.execPath), mode: 0o755 }]);
  const extra = makeTarGz([{ name: 'specs/verified.sla', data: 'verified extra payload' }]);
  const tool = { id: 'payload', repo: 'acme/mixed', summary: 'shared repository fixture',
    install: ['github-release'], launch: { type: 'bin', commands: ['payload'] }, verify: '--help',
    release: { asset: 'payload-v{version}-{os}-{arch}.zip', extraAssets: { specs: 'data-v{version}-{os}-{arch}.tar.gz' } } };
  writeCatalog(thirdParty, [tool]);
  const primaryName = (version: string) => `payload-v${version}-${os}-${arch}.zip`;
  const extraName = (version: string) => `data-v${version}-${os}-${arch}.tar.gz`;
  const release = (tag: string, version: string) => ({ tag_name: tag, assets: [
    { name: primaryName(version), digest: `sha256:${sha256(archive)}` },
    { name: extraName(version), digest: `sha256:${sha256(extra)}` },
  ] });
  const suffix = '1.2.3+engine-v2';
  const candidates = [
    release('tools-v0.1.0', '0.1.0'), release('decx-v0.0.9', '0.0.9'), release('v1.604', '1.604'),
    release(`tools-v${suffix}`, suffix), release(`v${suffix}`, suffix), release(suffix, suffix),
  ];
  const unrelated = [
    { ...release('tools-v9.0.0', '9.0.0'), draft: true },
    { ...release('tools-v8.0.0', '8.0.0'), prerelease: true },
    { tag_name: 'decx-v7.0.0', assets: [{ name: 'decx-7.0.0.tar.gz' }] },
    { ...release('tools-v6.0.0', '6.0.0'), assets: [{ name: primaryName('6.0.0') }] },
    { tag_name: 'tools-v5.0.0', assets: [{ name: 'payload-v5.0.0-other-host.zip' }, { name: extraName('5.0.0') }] },
  ];
  const routes: Record<string, string | Buffer> = {
    '/repos/acme/mixed/releases?per_page=100&page=1': JSON.stringify([
      ...unrelated, ...Array.from({ length: 95 }, (_, index) => ({ tag_name: `manager-v4.${index}`, assets: [] })),
    ]),
    '/repos/acme/mixed/releases?per_page=100&page=2': JSON.stringify(candidates),
  };
  for (const candidate of candidates) {
    routes[`/repos/acme/mixed/releases/tags/${encodeURIComponent(candidate.tag_name)}`] = JSON.stringify(candidate);
    for (const asset of candidate.assets) {
      routes[`/acme/mixed/releases/download/${encodeURIComponent(candidate.tag_name)}/${encodeURIComponent(asset.name)}`] = asset.name.endsWith('.zip') ? archive : extra;
    }
  }
  const server = await startFixtureServer(routes);
  t.after(() => server.close());
  const env = { HOME: root, USERPROFILE: root, DECX_GITHUB_API_BASE: server.url, DECX_GITHUB_DOWNLOAD_BASE: server.url };
  const execute = (args: string[]) => runCliAsync(['--home', home, '--third-party', thirdParty, ...args, '--no-links'], env);
  const installed = await execute(['install', 'payload']);
  assert.equal(installed.status, 0, installed.stderr + installed.stdout);
  assert.equal((installed.json as { releaseTag: string }).releaseTag, 'tools-v0.1.0');
  assert.equal(server.requested.filter(url => url === '/repos/acme/mixed/releases').length, 2);
  const provenance = path.join(home, 'share/payload/PROVENANCE');
  assert.match(fs.readFileSync(provenance, 'utf8'), /specs_checksum: verified/);
  assert.equal(fs.readFileSync(path.join(home, 'share/payload/specs/verified.sla'), 'utf8'), 'verified extra payload');
  for (const [version, tag] of [['0.1.0', 'tools-v0.1.0'], ['0.0.9', 'decx-v0.0.9'], ['1.604', 'v1.604'], ['tools-v0.1.0', 'tools-v0.1.0']]) {
    const before = server.requested.length;
    const updated = await execute(['update', 'payload', '--version', version!]);
    assert.equal(updated.status, 0, updated.stderr + updated.stdout);
    assert.equal((updated.json as { releaseTag: string }).releaseTag, tag);
    if (version === tag) assert.ok(!server.requested.slice(before).includes('/repos/acme/mixed/releases'), 'full tags bypass discovery');
  }
  for (const tag of [`tools-v${suffix}`, `v${suffix}`, suffix]) {
    const updated = await execute(['update', 'payload', '--version', tag]);
    assert.equal(updated.status, 0, updated.stderr + updated.stdout);
    assert.equal((updated.json as { releaseTag: string }).releaseTag, tag.startsWith('1') ? `tools-v${suffix}` : tag);
    assert.match(fs.readFileSync(provenance, 'utf8'), /specs_checksum: verified/);
  }
  const restored = await execute(['update', 'payload', '--version', 'tools-v0.1.0']);
  assert.equal(restored.status, 0, restored.stderr + restored.stdout);
  const absent = await execute(['update', 'payload', '--version', '99.0.0']);
  assert.match(absent.stdout, /RELEASE_RESOLVE_FAILED/);
  const record = fs.readFileSync(provenance);
  const metadataPath = '/repos/acme/mixed/releases/tags/tools-v0.1.0';
  // Omitted checksums and explicit null both require valid digests for every asset.
  for (const checksums of [undefined, null]) {
    writeCatalog(thirdParty, [{ ...tool, release: { ...tool.release, checksums } }]);
    for (const index of [0, 1]) {
      for (const digest of [undefined, null, 'sha256:invalid', `sha256:${'0'.repeat(64)}`]) {
        const metadata = release('tools-v0.1.0', '0.1.0');
        routes[metadataPath] = JSON.stringify({ ...metadata, assets: metadata.assets.map((asset, i) => i === index ? { ...asset, digest } : asset) });
        const rejected = await execute(['update', 'payload', '--version', 'tools-v0.1.0']);
        assert.notEqual(rejected.status, 0, rejected.stdout);
        assert.match(rejected.stdout, digest?.endsWith('0'.repeat(64)) ? /CHECKSUM_MISMATCH/ : /CHECKSUM_MISSING/);
        assert.deepEqual(fs.readFileSync(provenance), record);
      }
    }
  }
  routes[metadataPath] = JSON.stringify(candidates[0]);
  writeCatalog(thirdParty, [{ ...tool, release: { ...tool.release, tagPrefix: 'tools-v' } }]);
  for (const args of [[], ['--version', '0.1.0'], ['--version', 'v1.604']]) {
    const updated = await execute(['update', 'payload', ...args]);
    assert.equal(updated.status, 0, updated.stderr + updated.stdout);
    assert.equal((updated.json as { releaseTag: string }).releaseTag, args[1] === 'v1.604' ? 'v1.604' : 'tools-v0.1.0');
  }
  const launched = runCli(['--home', home, '--third-party', thirdParty, '-m', 'payload', '--version'], env);
  assert.equal(launched.status, 0, launched.stderr + launched.stdout);
  assert.equal(launched.stdout.trim(), process.version);
});

for (const format of ['zip', 'tar.gz']) {
  test(`CLI ${format}: real native payload, links, update, integrity and extraction failures preserve working install`, async t => {
    const root = tempDir('decx-install-');
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const home = path.join(root, '安装目录 with spaces');
    const links = path.join(root, 'links');
    const thirdParty = path.join(root, 'third_party');
    const name = process.platform === 'win32' ? 'probe.exe' : 'probe';
    writeCatalog(thirdParty, [{
      repo: 'acme/probe', id: 'probe', summary: 'real native payload', install: ['github-release'],
      launch: { type: 'bin', commands: ['probe'] }, verify: '--version',
      release: { tagPrefix: 'v', asset: `probe-{version}.${format}`, checksums: 'SHA256SUMS' },
    }]);
    const bytes = fs.readFileSync(process.execPath); // Actual host executable, never an echo shell substitute.
    const pack = format === 'zip' ? makeZip : makeTarGz;
    const valid = pack([{ name: `package/${name}`, data: bytes, mode: 0o755 }]);
    const traversal = pack([{ name: '../escaped', data: 'must not be written' }]);
    const version = process.versions.node;
    const routes: Record<string, Buffer | string> = {
      '/repos/acme/probe/releases': JSON.stringify([{ tag_name: `v${version}`, draft: false, prerelease: false, assets: [{ name: `probe-${version}.${format}` }] }]),
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
    const execute = (args: string[]) => runCliAsync(['--home', home, '--third-party', thirdParty, ...args], env);
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
