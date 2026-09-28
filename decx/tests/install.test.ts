/**
 * Installer tests: release download + sha256 verification, per-platform asset
 * resolution, specs staging, venv installs and the CLI wiring.  Everything is
 * offline: archives are built in-test and served by a local node:http server;
 * external programs run through an injected CommandRunner.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { provenanceFile } from '../src/config.ts';
import {
  InstallError,
  envCmdLauncherText,
  envLauncherText,
  installTool,
  normalizeReleaseTag,
  pathHint,
  releaseAssetName,
  releaseVersionFromTag,
  venvCmdLauncherText,
  venvLauncherText,
  type CommandResult,
  type CommandRunner,
  type CommandSpec,
  type InstallContext,
} from '../src/install.ts';
import { toolState } from '../src/inspect.ts';
import { loadManifests, type ReleaseSpec, type ToolManifest } from '../src/manifest.ts';
import type { PlatformKey } from '../src/platform.ts';
import {
  makeTarGz,
  makeZip,
  runCli,
  sha256,
  startFixtureServer,
  tempDir,
  SUBPROJECTS_DIR,
  writeFile,
  type FixtureServer,
} from './fixtures.ts';

const LIST_PATH = '/repos/acme/demo/releases';
const ASSET_PATH = '/acme/demo/releases/download/v1.0.0/demo-1.0.0-linux-amd64.tar.gz';
const WINDOWS_ASSET_PATH = '/acme/demo/releases/download/v1.0.0/demo-1.0.0-win-amd64.zip';
const SPECS_ASSET_PATH = '/acme/demo/releases/download/v1.0.0/demo-1.0.0-specs.tar.gz';
const CHECKSUMS_PATH = '/acme/demo/releases/download/v1.0.0/SHA256SUMS';

const DROIDASC_LIST_PATH = '/repos/jygzyc/decx/releases';
const DROIDASC_SOURCE_PATH = '/jygzyc/decx/releases/download/droidasc-v0.1.0/droidasc-0.1.0-source.tar.gz';

/** GitHub release list payload, newest first, as `/releases?per_page=100` returns it. */
function releaseList(...releases: Array<{ tag: string; prerelease?: boolean; draft?: boolean }>): Buffer {
  return Buffer.from(
    JSON.stringify(releases.map((release) => ({ tag_name: release.tag, prerelease: release.prerelease ?? false, draft: release.draft ?? false }))),
  );
}

/** The source tarball a droidasc-v* release carries. */
function droidascRoutes(extra: Array<{ name: string; data: string }> = []): Record<string, Buffer> {
  return {
    [DROIDASC_LIST_PATH]: releaseList({ tag: 'droidasc-v0.1.0' }),
    [DROIDASC_SOURCE_PATH]: makeTarGz([
      { name: 'main.py', data: 'print("droidasc")\n' },
      { name: 'droidasc/cli.py', data: 'VALUE = 1\n' },
      { name: 'requirements.txt', data: 'flask==3.0.0\n' },
      { name: 'pyproject.toml', data: '[project]\nname="droidasc"\nversion="0.1.0"\n[project.scripts]\ndroidasc="droidasc:main"\n' },
      ...extra,
    ]),
  };
}

/** Env for install calls: keeps the default link directory inside the test home. */
function homeEnv(home: string): NodeJS.ProcessEnv {
  return { HOME: home, USERPROFILE: home, PATH: '' };
}

function ok(stdout = ''): CommandResult {
  return { status: 0, stdout, stderr: '' };
}

function fail(stderr = 'not found'): CommandResult {
  return { status: 1, stdout: '', stderr };
}

function shipped(id: string): ToolManifest {
  const manifest = loadManifests(SUBPROJECTS_DIR).tools.find((tool) => tool.id === id);
  if (manifest === undefined) {
    throw new Error(`missing shipped manifest: ${id}`);
  }
  // Older fixture-based cases exercise the generic {source} recipe. The
  // published DroidASC manifest now installs directly from PyPI instead.
  if (id === 'droidasc') return {
    ...manifest,
    install: ['pip', 'install', '{source}'],
    release: { repository: 'jygzyc/decx', tagPrefix: 'droidasc-v', version: 'latest', checksums: 'droidasc-SHA256SUMS.txt', assets: { any: 'droidasc-{version}-source.tar.gz' } },
  };
  return manifest;
}

interface DemoExtras {
  checksums?: string | null;
  extraAssets?: Record<string, string>;
}

function demoManifest(extras: DemoExtras = {}): ToolManifest {
  return {
    manifest: 2,
    id: 'demo',
    install: ['github-release'],
    launch: { type: 'bin', commands: ['demo'] },
    summary: 'demo tool for installer tests',
    release: {
      repository: 'acme/demo',
      tagPrefix: 'v',
      assets: {
        'linux-amd64': 'demo-{version}-linux-amd64.tar.gz',
        'win-amd64': 'demo-{version}-win-amd64.zip',
      },
      checksums: extras.checksums === undefined ? 'SHA256SUMS' : extras.checksums,
      ...(extras.extraAssets !== undefined ? { extraAssets: extras.extraAssets } : {}),
    },
    verify: '--version',
  };
}

function context(
  home: string,
  repoRoot: string,
  url: string,
  run: CommandRunner,
  platform: PlatformKey = 'linux-amd64',
  verify?: boolean,
): InstallContext {
  const source = path.join(repoRoot, 'subprojects', 'decx-droidasc', 'source');
  if (fs.existsSync(path.join(source, 'main.py')) && !fs.existsSync(path.join(source, 'pyproject.toml'))) {
    writeFile(path.join(source, 'pyproject.toml'), '[project]\nname="droidasc"\nversion="0.1.0"\n[project.scripts]\ndroidasc="droidasc:main"\n');
  }
  return {
    home,
    repoRoot,
    env: homeEnv(home),
    platform,
    apiBase: url,
    downloadBase: url,
    log: () => {},
    run: async (spec) => {
      const result = await run(spec);
      if (path.basename(spec.command).startsWith('droidasc') && spec.args[0] === '--help' && result.stderr === 'not found') return ok('usage: droidasc\n');
      if (result.status === 0 && (
        (spec.args.includes('pip') && spec.args.includes('install') && spec.command !== 'python3') ||
        (spec.args[0] === '-m' && spec.args[1] === 'pip' && spec.args[2] === 'install')
      )) {
        const win = platform.startsWith('win');
        const script = path.join(home, 'runtime', 'droidasc', win ? 'Scripts' : 'bin', win ? 'droidasc.exe' : 'droidasc');
        if (!fs.existsSync(script)) writeFile(script, win ? 'MZ' : '#!/bin/sh\n', 0o755);
      }
      return result;
    },
    ...(verify !== undefined ? { verify } : {}),
  };
}

/** Runner for release installs: answers the launcher verification only. */
function releaseRunner(calls: string[] = [], verifyResult: CommandResult = ok('demo 1.0.0\n')): CommandRunner {
  return (spec) => {
    calls.push(`${spec.command} ${spec.args.join(' ')}`.trim());
    if (path.parse(spec.command).name === 'demo' && spec.args[0] === '--version') {
      return verifyResult;
    }
    return fail();
  };
}

function provenanceText(home: string, id: string): string {
  return fs.readFileSync(provenanceFile(home, id), 'utf8');
}

async function withDemoServer<T>(
  routes: Record<string, Buffer>,
  body: (server: FixtureServer) => Promise<T>,
  publishChecksums = true,
): Promise<T> {
  const served = { ...routes };
  if (publishChecksums) {
    const sums = new Map<string, string[]>();
    for (const [url, data] of Object.entries(routes)) {
      if (!url.includes('/releases/download/') || !/\.(tar\.gz|zip)$/.test(url)) continue;
      const directory = url.slice(0, url.lastIndexOf('/'));
      const checksum = `${directory}/${url.includes('/droidasc-v') ? 'droidasc-SHA256SUMS.txt' : 'SHA256SUMS'}`;
      sums.set(checksum, [...(sums.get(checksum) ?? []), `${sha256(data)}  ${url.slice(url.lastIndexOf('/') + 1)}`]);
    }
    for (const [url, lines] of sums) served[url] ??= Buffer.from(`${lines.join('\n')}\n`);
  }
  const server = await startFixtureServer(served);
  try {
    return await body(server);
  } finally {
    await server.close();
  }
}

interface ReleaseFixture {
  linuxTar: Buffer;
  windowsZip: Buffer;
  specsTar: Buffer;
}

function releaseFixture(): ReleaseFixture {
  return {
    linuxTar: makeTarGz([
      { name: 'demo', data: '#!/bin/sh\necho demo 1.0.0\n', mode: 0o755 },
      { name: 'docs/README.md', data: 'docs' },
    ]),
    windowsZip: makeZip([{ name: 'demo.exe', data: 'MZ fake', mode: 0o755 }]),
    specsTar: makeTarGz([{ name: 'specs/all.sla', data: 'sla' }]),
  };
}

test('release install downloads, verifies the checksum and stages bin + PROVENANCE', async () => {
  const home = tempDir('decx-home-');
  const repoRoot = tempDir('decx-repo-');
  const fixture = releaseFixture();
  await withDemoServer(
    {
      [ASSET_PATH]: fixture.linuxTar,
      [CHECKSUMS_PATH]: Buffer.from(`${sha256(fixture.linuxTar)}  demo-1.0.0-linux-amd64.tar.gz\n`),
    },
    async (server) => {
      const calls: string[] = [];
      const result = await installTool(
        demoManifest({ checksums: 'SHA256SUMS' }),
        { version: '1.0.0' },
        context(home, repoRoot, server.url, releaseRunner(calls)),
      );

      assert.equal(result.method, 'release download');
      assert.equal(result.version, '1.0.0');
      assert.equal(result.releaseTag, 'v1.0.0');
      assert.equal(result.asset, 'demo-1.0.0-linux-amd64.tar.gz');
      assert.equal(result.checksum, `verified (${sha256(fixture.linuxTar)})`);
      assert.deepEqual(result.binaries, ['demo']);
      assert.equal(result.launcher, path.join(home, 'bin', 'demo'));
      assert.ok(fs.existsSync(result.launcher));
      assert.ok(calls.some((call) => call.endsWith('bin/demo --version')));
      assert.ok(server.requested.includes(ASSET_PATH));
      assert.ok(server.requested.includes(CHECKSUMS_PATH));

      const provenance = provenanceText(home, 'demo');
      assert.match(provenance, /^tool: demo$/m);
      assert.match(provenance, /^install_method: release download$/m);
      assert.match(provenance, /^release_tag: v1\.0\.0$/m);
      assert.match(provenance, /^platform: linux-amd64$/m);
      assert.match(provenance, /^release_asset: demo-1\.0\.0-linux-amd64\.tar\.gz$/m);
      assert.match(provenance, new RegExp(`^sha256: ${sha256(fixture.linuxTar)}$`, 'm'));
      assert.match(provenance, /^specs_installed: 0$/m);

      const state = toolState(home, demoManifest());
      assert.equal(state.installed, true);
      assert.equal(state.version, '1.0.0');
    },
  );
});

test('a checksum mismatch refuses to install and leaves bin untouched', async () => {
  const home = tempDir('decx-home-');
  const repoRoot = tempDir('decx-repo-');
  const fixture = releaseFixture();
  await withDemoServer(
    {
      [ASSET_PATH]: fixture.linuxTar,
      [CHECKSUMS_PATH]: Buffer.from(`${'0'.repeat(64)}  demo-1.0.0-linux-amd64.tar.gz\n`),
    },
    async (server) => {
      await assert.rejects(
        () => installTool(demoManifest({ checksums: 'SHA256SUMS' }), { version: '1.0.0' }, context(home, repoRoot, server.url, releaseRunner())),
        (error: unknown) => error instanceof InstallError && error.code === 'CHECKSUM_MISMATCH',
      );
      assert.equal(fs.existsSync(path.join(home, 'bin')), false);
    },
  );
});

test('a missing checksum asset refuses installation even with functional verification disabled', async () => {
  const home = tempDir('decx-home-');
  const repoRoot = tempDir('decx-repo-');
  const fixture = releaseFixture();
  await withDemoServer({ [ASSET_PATH]: fixture.linuxTar }, async (server) => {
    await assert.rejects(
      () => installTool(demoManifest(), { version: '1.0.0' }, context(home, repoRoot, server.url, releaseRunner(), 'linux-amd64', false)),
      (error: unknown) => error instanceof InstallError && error.code === 'CHECKSUM_DOWNLOAD_FAILED',
    );
    assert.equal(fs.existsSync(path.join(home, 'share', 'demo')), false);
    assert.equal(fs.existsSync(path.join(home, 'bin')), false);
  }, false);
});

test('a checksums file that omits the asset refuses to install', async () => {
  const home = tempDir('decx-home-');
  const repoRoot = tempDir('decx-repo-');
  const fixture = releaseFixture();
  await withDemoServer(
    {
      [ASSET_PATH]: fixture.linuxTar,
      [CHECKSUMS_PATH]: Buffer.from(`${'0'.repeat(64)}  other-1.0.0-linux-amd64.tar.gz\n`),
    },
    async (server) => {
      await assert.rejects(
        () =>
          installTool(
            demoManifest({ checksums: 'SHA256SUMS' }),
            { version: '1.0.0' },
            context(home, repoRoot, server.url, releaseRunner()),
          ),
        (error: unknown) => error instanceof InstallError && error.code === 'CHECKSUM_MISSING',
      );
      assert.equal(fs.existsSync(path.join(home, 'bin')), false);
    },
  );
});

test('install without --version resolves the newest stable release through the API', async () => {
  const home = tempDir('decx-home-');
  const repoRoot = tempDir('decx-repo-');
  const fixture = releaseFixture();
  await withDemoServer(
    {
      [LIST_PATH]: releaseList({ tag: 'v1.1.0-rc1', prerelease: true }, { tag: 'v1.0.0' }),
      [ASSET_PATH]: fixture.linuxTar,
    },
    async (server) => {
      const result = await installTool(demoManifest(), {}, context(home, repoRoot, server.url, releaseRunner()));
      assert.equal(result.releaseTag, 'v1.0.0');
      assert.ok(server.requested.includes(LIST_PATH));
    },
  );
});

test('official release asset digests verify binary and specs without a checksum file', async () => {
  const fixture = releaseFixture();
  const tagPath = '/repos/acme/demo/releases/tags/v1.0.0';
  const metadata = (specsDigest: string) => Buffer.from(JSON.stringify({ assets: [
    { name: 'demo-1.0.0-linux-amd64.tar.gz', digest: `sha256:${sha256(fixture.linuxTar)}` },
    { name: 'demo-1.0.0-specs.tar.gz', digest: specsDigest },
  ] }));
  const manifest = demoManifest({ checksums: null, extraAssets: { specs: 'demo-{version}-specs.tar.gz' } });
  await withDemoServer({
    [tagPath]: metadata(`sha256:${sha256(fixture.specsTar)}`),
    [ASSET_PATH]: fixture.linuxTar,
    [SPECS_ASSET_PATH]: fixture.specsTar,
  }, async (server) => {
    const home = tempDir('decx-digest-success-');
    const result = await installTool(manifest, { version: '1.0.0' }, context(home, tempDir('decx-repo-'), server.url, releaseRunner()));
    assert.match(result.checksum ?? '', /verified/);
    assert.ok(server.requested.includes(tagPath));
    assert.equal(server.requested.includes(CHECKSUMS_PATH), false);
    assert.equal(result.provenance.specs_sha256, sha256(fixture.specsTar));
  });
  for (const digest of ['sha256:' + '0'.repeat(64), '']) {
    await withDemoServer({
      [tagPath]: metadata(digest),
      [ASSET_PATH]: fixture.linuxTar,
      [SPECS_ASSET_PATH]: fixture.specsTar,
    }, async (server) => {
      const home = tempDir('decx-digest-failure-');
      await assert.rejects(
        () => installTool(manifest, { version: '1.0.0' }, context(home, tempDir('decx-repo-'), server.url, releaseRunner())),
        (error: unknown) => error instanceof InstallError && error.code === (digest === '' ? 'CHECKSUM_MISSING' : 'CHECKSUM_MISMATCH'),
      );
      assert.equal(fs.existsSync(path.join(home, 'share', 'demo')), false);
    });
  }
});

test('release.version pins the install without querying latest', async () => {
  const home = tempDir('decx-home-');
  const fixture = releaseFixture();
  await withDemoServer({ [ASSET_PATH]: fixture.linuxTar }, async (server) => {
    const manifest = demoManifest();
    manifest.release!.version = '1.0.0';
    const result = await installTool(manifest, {}, context(home, tempDir('decx-repo-'), server.url, releaseRunner()));
    assert.equal(result.releaseTag, 'v1.0.0');
    assert.equal(server.requested.includes(LIST_PATH), false);
  });
});

test('replacing a binary prunes only its obsolete managed PATH link', async () => {
  const home = tempDir('decx-home-');
  const repo = tempDir('decx-repo-');
  const oldArchive = releaseFixture().linuxTar;
  await withDemoServer({ [ASSET_PATH]: oldArchive }, async (server) => {
    await installTool(demoManifest(), { version: '1.0.0' }, context(home, repo, server.url, releaseRunner()));
  });
  const oldLink = path.join(home, '.local', 'bin', 'demo');
  assert.ok(fs.lstatSync(oldLink).isSymbolicLink());
  const foreign = path.join(home, '.local', 'bin', 'unrelated');
  writeFile(foreign, 'leave alone');
  const newArchive = makeTarGz([{ name: 'next', data: '#!/bin/sh\necho next\n', mode: 0o755 }]);
  await withDemoServer({ [ASSET_PATH]: newArchive }, async (server) => {
    const manifest = { ...demoManifest(), launch: { type: 'bin' as const, commands: ['next'] } };
    await installTool(manifest, { version: '1.0.0' }, context(home, repo, server.url, releaseRunner(), 'linux-amd64', false));
  });
  assert.equal(fs.existsSync(oldLink), false);
  assert.equal(fs.existsSync(path.join(home, 'bin', 'demo')), false);
  assert.ok(fs.lstatSync(path.join(home, '.local', 'bin', 'next')).isSymbolicLink());
  assert.equal(fs.readFileSync(foreign, 'utf8'), 'leave alone');
});

test('an explicit --version installs that exact release without consulting the newest', async () => {
  const home = tempDir('decx-home-');
  const repoRoot = tempDir('decx-repo-');
  const fixture = releaseFixture();
  const v2AssetPath = '/acme/demo/releases/download/v2.0.0/demo-2.0.0-linux-amd64.tar.gz';
  await withDemoServer(
    {
      [LIST_PATH]: releaseList({ tag: 'v2.0.0' }),
      [v2AssetPath]: fixture.linuxTar,
    },
    async (server) => {
      const result = await installTool(
        demoManifest(),
        { version: '2.0.0' },
        context(home, repoRoot, server.url, releaseRunner([], ok('demo 2.0.0\n'))),
      );
      assert.equal(result.releaseTag, 'v2.0.0');
      assert.equal(result.asset, 'demo-2.0.0-linux-amd64.tar.gz');
      assert.ok(server.requested.includes(v2AssetPath));
      assert.ok(!server.requested.includes(LIST_PATH));
      assert.match(provenanceText(home, 'demo'), /^release_tag: v2\.0\.0$/m);
    },
  );
});

test('the Windows asset is a zip and installs demo.exe', async () => {
  const home = tempDir('decx-home-');
  const repoRoot = tempDir('decx-repo-');
  const fixture = releaseFixture();
  await withDemoServer({ [WINDOWS_ASSET_PATH]: fixture.windowsZip }, async (server) => {
    const result = await installTool(
      demoManifest(),
      { version: 'v1.0.0' },
      context(home, repoRoot, server.url, releaseRunner([], ok('demo 1.0.0\n')), 'win-amd64'),
    );
    assert.equal(result.asset, 'demo-1.0.0-win-amd64.zip');
    assert.deepEqual(result.binaries, ['demo.exe']);
    assert.ok(result.launcher.endsWith('demo.exe'));
    assert.ok(fs.existsSync(result.launcher));
    assert.match(provenanceText(home, 'demo'), /^platform: win-amd64$/m);
  });
});

test('an unsupported platform fails before downloading', async () => {
  const home = tempDir('decx-home-');
  const repoRoot = tempDir('decx-repo-');
  await assert.rejects(
    () => installTool(demoManifest(), { version: '1.0.0' }, context(home, repoRoot, 'http://127.0.0.1:9', releaseRunner(), 'darwin-arm64')),
    (error: unknown) => error instanceof InstallError && error.code === 'UNSUPPORTED_PLATFORM',
  );
});

test('the specs asset is staged under <prefix>/specs', async () => {
  const fixture = releaseFixture();
  const routes = {
    [ASSET_PATH]: fixture.linuxTar,
    [SPECS_ASSET_PATH]: fixture.specsTar,
  };
  await withDemoServer(routes, async (server) => {
    const home = tempDir('decx-home-');
    const repoRoot = tempDir('decx-repo-');
    const manifest = demoManifest({ extraAssets: { specs: 'demo-{version}-specs.tar.gz' } });
    const result = await installTool(manifest, { version: '1.0.0' }, context(home, repoRoot, server.url, releaseRunner()));
    assert.equal(result.specsAsset, 'demo-1.0.0-specs.tar.gz');
    assert.equal(result.specsInstalled, 1);
    assert.ok(fs.existsSync(path.join(home, 'share', 'demo', 'specs', 'all.sla')));
    assert.match(provenanceText(home, 'demo'), /^specs_asset: demo-1\.0\.0-specs\.tar\.gz$/m);
  });
});

test('extra assets also require a matching checksum before anything is committed', async () => {
  const fixture = releaseFixture();
  for (const extraSum of ['', `${'0'.repeat(64)}  demo-1.0.0-specs.tar.gz\n`]) {
    const home = tempDir('decx-home-');
    const calls: string[] = [];
    await withDemoServer({
      [ASSET_PATH]: fixture.linuxTar,
      [SPECS_ASSET_PATH]: fixture.specsTar,
      [CHECKSUMS_PATH]: Buffer.from(`${sha256(fixture.linuxTar)}  demo-1.0.0-linux-amd64.tar.gz\n${extraSum}`),
    }, async (server) => {
      await assert.rejects(() => installTool(demoManifest({ extraAssets: { specs: 'demo-{version}-specs.tar.gz' } }), { version: '1.0.0', noLinks: true }, context(home, tempDir('decx-repo-'), server.url, releaseRunner(calls))),
        (error: unknown) => error instanceof InstallError && error.code === (extraSum === '' ? 'CHECKSUM_MISSING' : 'CHECKSUM_MISMATCH'));
    });
    assert.deepEqual(calls, []);
    assert.deepEqual(fs.readdirSync(home), []);
  }
});

test('a failing functional check aborts the install unless verification is off', async () => {
  const fixture = releaseFixture();
  await withDemoServer({ [ASSET_PATH]: fixture.linuxTar }, async (server) => {
    const home = tempDir('decx-home-');
    const repoRoot = tempDir('decx-repo-');
    await assert.rejects(
      () =>
        installTool(
          demoManifest(),
          { version: '1.0.0' },
          context(home, repoRoot, server.url, releaseRunner([], fail('bad binary'))),
        ),
      (error: unknown) => error instanceof InstallError && error.code === 'VERIFY_FAILED',
    );
    assert.equal(fs.existsSync(path.join(home, 'bin')), false);

    const uncheckedHome = tempDir('decx-home-');
    const result = await installTool(
      demoManifest(),
      { version: '1.0.0' },
      context(uncheckedHome, repoRoot, server.url, releaseRunner([], fail('bad binary')), 'linux-amd64', false),
    );
    assert.ok(fs.existsSync(result.launcher));
  });
});

test('published DroidASC installs from PyPI without fetching a source archive', async () => {
  const manifest = loadManifests(SUBPROJECTS_DIR).tools.find((tool) => tool.id === 'droidasc');
  assert.ok(manifest);
  const home = tempDir('decx-pypi-');
  const calls: CommandSpec[] = [];
  let installedVersion = '0.1.0';
  const run: CommandRunner = (spec) => {
    calls.push(spec);
    if (spec.args[0] === '--version') return ok('Python 3.11.5\n');
    if (spec.args[0] === '-m' && spec.args[1] === 'venv') {
      writeFile(path.join(home, 'runtime', 'droidasc', 'bin', 'python'), '#!/bin/sh\n', 0o755);
    }
    if (spec.args[0] === '-c') return ok(`${installedVersion}\n`);
    return ok();
  };
  const ctx = context(home, tempDir('decx-repo-'), 'http://127.0.0.1:9', run);
  const installed = await installTool(manifest, { version: '0.1.0', noLinks: true }, ctx);
  assert.equal(installed.version, '0.1.0');
  assert.equal(installed.provenance.install_command, 'pip install droidasc==0.1.0');
  assert.deepEqual(calls.find((spec) => spec.args[1] === 'pip')?.args, ['-m', 'pip', 'install', 'droidasc==0.1.0']);
  assert.equal(calls.some((spec) => spec.command === 'git'), false);
  assert.equal(installed.releaseTag, undefined);
  installedVersion = '0.1.1.post2';
  const updated = await installTool(manifest, { version: 'latest', noLinks: true }, ctx);
  assert.equal(updated.version, '0.1.1.post2');
  assert.equal(updated.provenance.install_command, 'pip install droidasc');
});

test('droidasc installs a private venv with a pass-through POSIX launcher', async () => {
  await withDemoServer(droidascRoutes(), async (server) => {
    const home = tempDir('decx-home-');
    const repoRoot = tempDir('decx-repo-');
    const calls: string[][] = [];
    const run: CommandRunner = (spec) => {
      calls.push([spec.command, ...spec.args]);
      if (spec.command === 'python3' && spec.args[0] === '--version') {
        return { status: 0, stdout: '', stderr: 'Python 3.11.5\n' };
      }
      if (spec.command === 'python3' && spec.args[0] === '-m' && spec.args[1] === 'venv') {
        const dir = spec.args[2];
        if (dir === undefined) {
          throw new Error('fake python got no venv directory');
        }
        writeFile(path.join(dir, 'bin', 'python'), '#!/bin/sh\n', 0o755);
        writeFile(path.join(dir, 'Scripts', 'python.exe'), 'MZ', 0o755);
        return ok();
      }
      if (path.basename(spec.command) === 'python' || path.basename(spec.command) === 'python.exe') {
        return ok();
      }
      return fail();
    };

    const result = await installTool(shipped('droidasc'), {}, context(home, repoRoot, server.url, run));
    assert.equal(result.method, 'python venv');
    assert.deepEqual(result.binaries, ['droidasc']);
    const launcher = path.join(home, 'bin', 'droidasc');
    assert.equal(
      fs.readFileSync(launcher, 'utf8'),
      venvLauncherText({ id: 'droidasc', platformOs: 'linux', venvBin: 'bin', command: 'droidasc' }),
    );
    assert.deepEqual(fs.readdirSync(path.join(home, 'share', 'droidasc')), ['PROVENANCE']);
    assert.ok(fs.existsSync(path.join(home, 'runtime', 'droidasc', 'bin', 'droidasc')));

    const pip = calls.find((args) => args.includes('-m') && args.includes('pip'));
    assert.ok(pip !== undefined);
    assert.deepEqual(pip.slice(1, 4), ['-m', 'pip', 'install']);
    assert.equal(pip.includes('-r'), false);
    assert.match(pip[pip.length - 1] ?? '', /[\\/]\.decx-stage-[^\\/]+[\\/]extract/);

    const provenance = provenanceText(home, 'droidasc');
    assert.match(provenance, /^install_method: python venv$/m);
    assert.match(provenance, /^install_command: pip install \{source\}$/m);
    assert.match(provenance, /^python: Python 3\.11\.5 \(python3\)$/m);
    assert.match(provenance, /^python_manager: pip$/m);
    assert.match(provenance, /^platform: linux-amd64$/m);
    assert.match(provenance, new RegExp(`^venv: ${path.join(home, 'runtime', 'droidasc', 'bin', 'python').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  });

  });

test('the explicit pip install argv is used even if uv is present', async () => {
  await withDemoServer(droidascRoutes(), async (server) => {
    const home = tempDir('decx-home-');
    const calls: CommandSpec[] = [];
    const run: CommandRunner = (spec) => {
      calls.push(spec);
      if (spec.command === 'python3' && spec.args[0] === '--version') return ok('Python 3.11.5\n');
      if (spec.args[0] === '-m' && spec.args[1] === 'venv') writeFile(path.join(home, 'runtime', 'droidasc', 'bin', 'python'), '#!/bin/sh\n', 0o755);
      return ok();
    };
    await installTool(shipped('droidasc'), {}, context(home, tempDir('decx-repo-'), server.url, run));
    const install = calls.find((call) => call.args[0] === '-m' && call.args[1] === 'pip');
    assert.deepEqual(install?.args.slice(0, 3), ['-m', 'pip', 'install']);
    assert.match(install?.args.at(-1) ?? '', /\.decx-stage-[^/]+[\/]extract/);
    assert.equal(calls.some((call) => call.command === 'uv'), false);
  });
});

test('a vendored checkout is preferred over the release archive', async () => {
  const sha = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
  await withDemoServer({}, async (server) => {
    const home = tempDir('decx-home-');
    const repoRoot = tempDir('decx-repo-');
    const source = path.join(repoRoot, 'subprojects', 'decx-droidasc', 'source');
    writeFile(path.join(source, 'main.py'), '# checkout entry point\n', 0o644);
    writeFile(path.join(source, 'requirements.txt'), 'flask==9.9.9\n', 0o644);
    writeFile(path.join(source, 'pyproject.toml'), '[project]\nname="droidasc"\nversion="0.1.0"\n[project.scripts]\ndroidasc="droidasc:main"\n');
    writeFile(path.join(source, 'droidasc', 'cli.py'), 'VALUE = 2\n', 0o644);
    const calls: string[][] = [];
    const run: CommandRunner = (spec) => {
      calls.push([spec.command, ...spec.args]);
      if (spec.command === 'git' && spec.args.includes('rev-parse')) {
        return ok(`${sha}\n`);
      }
      if (spec.command === 'git' && spec.args.includes('describe')) {
        return ok('v0.1.0\n');
      }
      if (spec.command === 'git') {
        return ok();
      }
      if (spec.command === 'python3' && spec.args[0] === '--version') {
        return { status: 0, stdout: '', stderr: 'Python 3.11.5\n' };
      }
      if (spec.command === 'python3' && spec.args[0] === '-m' && spec.args[1] === 'venv') {
        const dir = spec.args[2];
        if (dir === undefined) {
          throw new Error('fake python got no venv directory');
        }
        writeFile(path.join(dir, 'bin', 'python'), '#!/bin/sh\n', 0o755);
        return ok();
      }
      return path.basename(spec.command) === 'python' ? ok() : fail();
    };

    // No release routes are served: anything that tries to resolve a tag or
    // download an asset fails, so the checkout is the only way this install can
    // succeed.
    const result = await installTool(shipped('droidasc'), { noLinks: true }, context(home, repoRoot, server.url, run));
    assert.equal(result.method, 'python venv');
    assert.equal(result.version, '0.1.0');
    assert.equal(calls.some((args) => args[0] === 'curl' || args[0] === 'gh'), false);
    const provenance = provenanceText(home, 'droidasc');
    assert.match(provenance, /^source: subprojects[\\/]decx-droidasc[\\/]source$/m);
    assert.match(provenance, new RegExp(`^source_commit: ${sha}$`, 'm'));
    assert.match(provenance, /^source_tag: v0\.1\.0$/m);
    assert.match(provenance, /^version: 0\.1\.0$/m);
    assert.equal(provenance.includes('release_asset'), false, 'nothing is downloaded');
    assert.deepEqual(fs.readdirSync(path.join(home, 'share', 'droidasc')), ['PROVENANCE']);
    assert.ok(calls.some((args) => args.at(-1) === source), 'installs checkout as a package');
  });
});

test('the installed Python payload retains only provenance, not source or shipped environments', async () => {
  await withDemoServer(droidascRoutes([{ name: '.venv/pyvenv.cfg', data: 'home = /usr\n' }]), async (server) => {
    const home = tempDir('decx-home-');
    const run: CommandRunner = (spec) => {
      if (spec.args[0] === '--version') return ok('Python 3.11.5\n');
      if (spec.args[0] === '-m' && spec.args[1] === 'venv') {
        writeFile(path.join(home, 'runtime', 'droidasc', 'bin', 'python'), '#!/bin/sh\n', 0o755);
      }
      return ok();
    };
    await installTool(shipped('droidasc'), {}, context(home, tempDir('decx-repo-'), server.url, run));
    assert.deepEqual(fs.readdirSync(path.join(home, 'share', 'droidasc')), ['PROVENANCE']);
    assert.equal(fs.existsSync(path.join(home, 'runtime', 'droidasc', 'pyvenv.cfg')), false);
  });
});

test('a too-old default python3 is skipped in favour of a versioned interpreter', async () => {
  await withDemoServer(droidascRoutes(), async (server) => {
    const home = tempDir('decx-home-');
    const repoRoot = tempDir('decx-repo-');
    const versions: Record<string, string> = {
      python3: 'Python 3.9.6\n',
      'python3.12': 'Python 3.12.4\n',
    };
    const calls: string[][] = [];
    const run: CommandRunner = (spec) => {
      calls.push([spec.command, ...spec.args]);
      const version = versions[spec.command];
      if (spec.args[0] === '--version') {
        return version === undefined ? fail() : { status: 0, stdout: '', stderr: version };
      }
      if (spec.args[0] === '-m' && spec.args[1] === 'venv') {
        const dir = spec.args[2];
        if (dir === undefined) {
          throw new Error('fake python got no venv directory');
        }
        writeFile(path.join(dir, 'bin', 'python'), '#!/bin/sh\n', 0o755);
        return ok();
      }
      return path.basename(spec.command).startsWith('python') ? ok() : fail();
    };

    const result = await installTool(shipped('droidasc'), {}, context(home, repoRoot, server.url, run));
    assert.equal(result.method, 'python venv');
    const venv = calls.find((args) => args.includes('-m') && args.includes('venv'));
    assert.equal(venv?.[0], 'python3.12', 'the venv uses the interpreter that satisfies requires.python');
    assert.match(provenanceText(home, 'droidasc'), /^python: Python 3\.12\.4 \(python3\.12\)$/m);

    // Nothing new enough on PATH: stop with an actionable error instead of a
    // venv the tool cannot run in.
    const stale = tempDir('decx-home-');
    const staleRun: CommandRunner = (spec) =>
      spec.args[0] === '--version' ? { status: 0, stdout: 'Python 3.9.6\n', stderr: '' } : fail();
    await assert.rejects(
      () => installTool(shipped('droidasc'), {}, context(stale, repoRoot, server.url, staleRun)),
      (error: unknown) => error instanceof InstallError && error.code === 'PYTHON_TOO_OLD',
    );
    assert.equal(fs.existsSync(path.join(stale, 'share', 'droidasc', 'PROVENANCE')), false, 'nothing is recorded');
  });

  });

test('droidasc on Windows creates the cmd launcher and uses Scripts/python.exe', async () => {
  await withDemoServer(droidascRoutes(), async (server) => {
    const home = tempDir('decx-home-');
    const repoRoot = tempDir('decx-repo-');
    const run: CommandRunner = (spec) => {
      if (spec.command === 'python3' && spec.args[0] === '--version') {
        return { status: 0, stdout: 'Python 3.11.5\n', stderr: '' };
      }
      if (spec.command === 'python3' && spec.args[0] === '-m' && spec.args[1] === 'venv') {
        const dir = spec.args[2];
        if (dir === undefined) {
          throw new Error('fake python got no venv directory');
        }
        writeFile(path.join(dir, 'Scripts', 'python.exe'), 'MZ', 0o755);
        return ok();
      }
      if (path.basename(spec.command) === 'python' || path.basename(spec.command) === 'python.exe') {
        return ok();
      }
      return fail();
    };

    const result = await installTool(shipped('droidasc'), {}, context(home, repoRoot, server.url, run, 'win-amd64'));
    assert.ok(result.launcher.endsWith(path.join('bin', 'droidasc.cmd')));
    assert.equal(
      fs.readFileSync(result.launcher, 'utf8'),
      venvCmdLauncherText({ id: 'droidasc', command: 'droidasc' }),
    );
    assert.match(provenanceText(home, 'droidasc'), /^platform: win-amd64$/m);
    assert.match(provenanceText(home, 'droidasc'), /Scripts[\\/]python\.exe$/m);
  });

  });

test('a manifest with env gets launcher wrappers that export the environment', async () => {
  const home = tempDir('decx-home-');
  const repoRoot = tempDir('decx-repo-');
  const fixture = releaseFixture();
  const manifest: ToolManifest = {
    ...demoManifest({ extraAssets: { specs: 'demo-{version}-specs.tar.gz' } }),
    env: { DEMO_SPECS: '{prefix}/specs' },
  };
  await withDemoServer(
    {
      [ASSET_PATH]: fixture.linuxTar,
      [SPECS_ASSET_PATH]: fixture.specsTar,
    },
    async (server) => {
      const result = await installTool(
        manifest,
        { version: '1.0.0' },
        context(home, repoRoot, server.url, releaseRunner(), 'linux-amd64', false),
      );
      const packaged = path.join(home, 'share', 'demo', 'bin', 'demo');
      const specs = path.join(home, 'share', 'demo', 'specs');
      assert.equal(result.launcher, path.join(home, 'bin', 'demo'));
      assert.deepEqual(result.binaries, ['demo']);
      assert.ok(fs.existsSync(packaged), 'the packaged binary moved into the payload');
      assert.equal(fs.readFileSync(result.launcher, 'utf8'), envLauncherText(packaged, { DEMO_SPECS: specs }));
      assert.ok(fs.existsSync(path.join(specs, 'all.sla')));
      const provenance = provenanceText(home, 'demo');
      assert.match(provenance, /^env: DEMO_SPECS=/m);
      assert.ok(provenance.includes(specs), 'PROVENANCE records the resolved prefix');
      assert.match(provenance, /^specs_installed: 1$/m);
    },
  );
});

test('install refuses to shadow a foreign store file unless --force is given', async () => {
  const home = tempDir('decx-home-');
  const repoRoot = tempDir('decx-repo-');
  const fixture = releaseFixture();
  const foreign = path.join(home, 'bin', 'demo');
  writeFile(foreign, '#!/bin/sh\necho someone else\n', 0o755);
  await withDemoServer({ [ASSET_PATH]: fixture.linuxTar }, async (server) => {
    const manifest = demoManifest();
    await assert.rejects(
      () => installTool(manifest, { version: '1.0.0' }, context(home, repoRoot, server.url, releaseRunner())),
      (error: unknown) => error instanceof InstallError && error.code === 'BIN_CONFLICT',
    );
    assert.equal(fs.readFileSync(foreign, 'utf8'), '#!/bin/sh\necho someone else\n');
    assert.equal(fs.existsSync(provenanceFile(home, 'demo')), false, 'nothing was committed');

    const forced = await installTool(
      manifest,
      { version: '1.0.0', force: true },
      context(home, repoRoot, server.url, releaseRunner()),
    );
    assert.equal(forced.method, 'release download');
    assert.match(fs.readFileSync(foreign, 'utf8'), /demo 1\.0\.0/);
    const saved = fs.readdirSync(home).find((name) => name.startsWith('.decx-overwritten-demo-'));
    assert.ok(saved);
    assert.equal(fs.readFileSync(path.join(home, saved, 'demo'), 'utf8'), '#!/bin/sh\necho someone else\n');
    assert.ok(fs.existsSync(provenanceFile(home, 'demo')));
  });
});

test('release asset names cannot escape the staging download directory', async () => {
  const home = tempDir('decx-home-');
  const repoRoot = tempDir('decx-repo-');
  const manifest = demoManifest();
  assert.ok(manifest.release?.assets);
  manifest.release.assets['linux-amd64'] = '../outside.tar.gz';
  await assert.rejects(
    () => installTool(manifest, { version: '1.0.0' }, context(home, repoRoot, 'http://127.0.0.1:9', releaseRunner())),
    (error: unknown) => error instanceof InstallError && error.code === 'INVALID_MANIFEST',
  );
  assert.ok(!fs.readdirSync(home).some((name) => name.startsWith('.decx-stage-')));
});

test('install never replaces an unrelated payload even with --force', async () => {
  const home = tempDir('decx-home-');
  const repoRoot = tempDir('decx-repo-');
  const payload = path.join(home, 'share', 'demo');
  writeFile(path.join(payload, 'notes.txt'), 'keep me');
  const fixture = releaseFixture();
  await withDemoServer({ [ASSET_PATH]: fixture.linuxTar }, async (server) => {
    await assert.rejects(
      () => installTool(demoManifest(), { version: '1.0.0', force: true }, context(home, repoRoot, server.url, releaseRunner())),
      (error: unknown) => error instanceof InstallError && error.code === 'PAYLOAD_CONFLICT',
    );
    assert.equal(fs.readFileSync(path.join(payload, 'notes.txt'), 'utf8'), 'keep me');
  });
});

test('CLI end-to-end: a managed install is observable on disk and install is idempotent-guarded', async () => {
  const home = tempDir('decx-home-');
  const repoRoot = tempDir('decx-repo-');
  const subprojectsDir = tempDir('decx-subprojects-');
  writeFile(path.join(subprojectsDir, 'demo', 'decx-demo.json'), JSON.stringify(demoManifest()));
  const fixture = releaseFixture();
  await withDemoServer({ [ASSET_PATH]: fixture.linuxTar }, async (server) => {
    await installTool(
      demoManifest(),
      { version: '1.0.0' },
      context(home, repoRoot, server.url, releaseRunner(), 'linux-amd64', false),
    );
    // Executables in <home>/bin, payload in <home>/share/<id>, a PATH link in
    // ~/.local/bin: the store itself is the report.
    assert.ok(fs.existsSync(path.join(home, 'bin', 'demo')));
    assert.ok(fs.existsSync(path.join(home, 'share', 'demo', 'PROVENANCE')));
    const link = path.join(home, '.local', 'bin', process.platform === 'win32' ? 'demo.cmd' : 'demo');
    assert.ok(fs.existsSync(link), `${link} should exist`);
    if (process.platform !== 'win32') {
      assert.equal(fs.realpathSync(link), fs.realpathSync(path.join(home, 'bin', 'demo')));
    }

    const again = runCli(['install', 'demo', '--home', home, '--subprojects', subprojectsDir], { HOME: home });
    assert.equal(again.status, 1);
    assert.equal((again.json as { error: { code: string } }).error.code, 'ALREADY_INSTALLED');
  });
});

test('CLI module invocation takes --home before -m and forwards the rest verbatim', () => {
  const home = tempDir('decx-home-');
  const subprojectsDir = tempDir('decx-subprojects-');
  writeFile(path.join(subprojectsDir, 'demo', 'decx-demo.json'), JSON.stringify(demoManifest()));
  // A launcher that records its argv and exits 7: the record proves nothing after
  // the id was touched, the exit code proves it is forwarded.
  const probe = path.join(home, 'argv.txt');
  if (process.platform === 'win32') {
    writeFile(path.join(home, 'bin', 'demo.cmd'), `@echo off\r\n> "${probe}" echo %*\r\nexit /b 7\r\n`);
  } else {
    writeFile(path.join(home, 'bin', 'demo'), `#!/bin/sh\nprintf '%s' "$*" > '${probe}'\nexit 7\n`, 0o755);
  }
  writeFile(provenanceFile(home, 'demo'), 'tool: demo\ninstaller: decx install\ninstall_method: release download\n');

  const forwarded = runCli(['--home', home, '--subprojects', subprojectsDir, '-m', 'demo', '--home', '/tmp/elsewhere']);
  assert.equal(forwarded.status, 7);
  assert.match(fs.readFileSync(probe, 'utf8'), /--home \/tmp\/elsewhere/);
});

test('CLI help covers the installer commands', () => {
  const help = runCli(['install', '--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /usage: decx install <tool>/);
  assert.match(help.stdout, /--version <tag>/);
  assert.ok(!help.stdout.includes('--from-source'));

  const moduleUsage = runCli(['-m']);
  assert.equal(moduleUsage.status, 2);
  assert.equal((moduleUsage.json as { error: { code: string } }).error.code, 'USAGE');

  const unknown = runCli(['help', 'nope']);
  assert.equal(unknown.status, 2);
});

test('checksum transport failures never reach verification or installation', async () => {
  for (const failure of ['http', 'disconnect']) {
    const fixture = releaseFixture();
    const server = http.createServer((req, res) => {
      if (req.url === ASSET_PATH) { res.end(fixture.linuxTar); return; }
      if (failure === 'disconnect') { req.socket.destroy(); return; }
      res.writeHead(503); res.end('unavailable');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const home = tempDir('decx-home-');
      const calls: string[] = [];
      await assert.rejects(
        () => installTool(demoManifest(), { version: '1.0.0', noLinks: true }, context(home, tempDir('decx-repo-'), `http://127.0.0.1:${address.port}`, releaseRunner(calls))),
        (error: unknown) => error instanceof InstallError && error.code === 'CHECKSUM_DOWNLOAD_FAILED',
      );
      assert.deepEqual(calls, []);
      assert.deepEqual(fs.readdirSync(home), []);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }
});

/** A minimal checkout and fake interpreter; no toolchain or network is used. */
function pythonCheckout(repo: string): string {
  const source = path.join(repo, 'subprojects', 'decx-droidasc', 'source');
  writeFile(path.join(source, 'main.py'), '# entry\n');
  writeFile(path.join(source, 'requirements.txt'), 'dependency==1\n');
  writeFile(path.join(source, 'droidasc', 'cli.py'), '# package\n');
  return source;
}

function pythonRunner(calls: CommandSpec[] = [], broken = '', windows = false): CommandRunner {
  return (spec) => {
    calls.push(spec);
    if (spec.command === 'git') {
      if (broken === 'git') return fail();
      if (spec.args.includes('rev-parse')) return ok('abc123\n');
      if (spec.args.includes('describe')) return broken === 'untagged' ? fail() : ok('v0.1.0\n');
      return ok(broken === 'dirty' ? ' M main.py\n' : '');
    }
    if (spec.command === 'python3' && spec.args[0] === '--version') return ok('Python 3.12.0\n');
    if (spec.args[1] === 'venv') {
      writeFile(path.join(spec.args[2]!, windows ? 'Scripts' : 'bin', windows ? 'python.exe' : 'python'), 'fake interpreter', 0o755);
      return broken === 'venv' ? fail('venv failed after creating files') : ok();
    }
    if (spec.command === 'uv' && spec.args[0] === '--version') return broken === 'uv' ? ok('uv 0.9.5') : fail();
    if (spec.command === 'pipx') return fail();
    if (spec.args.includes('install')) return ['pip', 'uv'].includes(broken) ? fail('dependency install failed') : ok();
    return broken === 'verify' && spec.args.includes('--help') ? fail('verification failed') : ok();
  };
}

test('DECX_PYTHON uses the supplied environment and failed Python probes are rejected', async () => {
  const home = tempDir('decx-home-');
  const repo = tempDir('decx-repo-');
  pythonCheckout(repo);
  const calls: CommandSpec[] = [];
  const fake = pythonRunner(calls);
  const ctx = context(home, repo, 'http://127.0.0.1:9', (spec) => spec.command === 'chosen-python' && spec.args[0] === '--version' ? ok('Python 3.12.0') : fake(spec));
  ctx.env = { ...homeEnv(home), DECX_PYTHON: 'chosen-python' };
  await installTool(shipped('droidasc'), { noLinks: true }, ctx);
  assert.equal(calls.find((call) => call.args[1] === 'venv')?.command, 'chosen-python');
  const failedHome = tempDir('decx-home-');
  await assert.rejects(() => installTool(shipped('droidasc'), { noLinks: true }, context(failedHome, repo, 'http://127.0.0.1:9', (spec) =>
    spec.args[0] === '--version' ? { status: 1, stdout: 'Python 3.12.0', stderr: '' } : fail(),
  )), (error: unknown) => error instanceof InstallError && error.code === 'PYTHON_NOT_FOUND');
});

test('install argv preserves options without invoking a shell', async () => {
  const home = tempDir('decx-home-');
  const repo = tempDir('decx-repo-');
  const source = pythonCheckout(repo);
  const calls: CommandSpec[] = [];
  const manifest = { ...shipped('droidasc'), install: ['pip', 'install', '--no-deps', '{source}'] };
  await installTool(manifest, { noLinks: true }, context(home, repo, 'http://127.0.0.1:9', pythonRunner(calls)));
  const install = calls.find((call) => call.args[0] === '-m' && call.args[1] === 'pip')!;
  assert.deepEqual(install.args, ['-m', 'pip', 'install', '--no-deps', source]);
  assert.match(provenanceText(home, 'droidasc'), /^install_command: pip install --no-deps \{source\}$/m);
});

test('a linked checkout root is rejected before running its code', async () => {
  const home = tempDir('decx-home-');
  const repo = tempDir('decx-repo-');
  const outside = pythonCheckout(tempDir('decx-outside-'));
  const source = path.join(repo, 'subprojects', 'decx-droidasc', 'source');
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.symlinkSync(outside, source, 'junction');
  const calls: CommandSpec[] = [];
  await assert.rejects(() => installTool(shipped('droidasc'), { noLinks: true }, context(home, repo, 'http://127.0.0.1:9', pythonRunner(calls))),
    (error: unknown) => error instanceof InstallError && error.code === 'UNSAFE_PYTHON_PATH');
  assert.deepEqual(calls, []);
});

test('an explicit checkout version must match a known, clean, exact tag', async () => {
  const repo = tempDir('decx-repo-');
  pythonCheckout(repo);
  for (const [version, broken, accepted] of [
    ['0.1.0', '', true], ['v0.1.0', '', true], ['9.0.0', '', false],
    ['0.1.0', 'dirty', false], ['0.1.0', 'git', false], ['0.1.0', 'untagged', false],
  ] as const) {
    const home = tempDir('decx-home-');
    const calls: CommandSpec[] = [];
    const install = () => installTool(shipped('droidasc'), { version, noLinks: true }, context(home, repo, 'http://127.0.0.1:9', pythonRunner(calls, broken)));
    if (accepted) {
      assert.equal((await install()).version, '0.1.0');
    } else {
      await assert.rejects(install, (error: unknown) => error instanceof InstallError && error.code === 'VERSION_MISMATCH');
      assert.ok(calls.every((call) => call.command === 'git'));
      assert.deepEqual(fs.readdirSync(home), []);
    }
  }
});

test('a pinned manifest version also rejects an older local checkout', async () => {
  const repo = tempDir('decx-repo-');
  pythonCheckout(repo);
  const home = tempDir('decx-home-');
  const manifest = shipped('droidasc');
  manifest.release!.version = '9.0.0';
  const calls: CommandSpec[] = [];
  await assert.rejects(
    () => installTool(manifest, { noLinks: true }, context(home, repo, 'http://127.0.0.1:9', pythonRunner(calls))),
    (error: unknown) => error instanceof InstallError && error.code === 'VERSION_MISMATCH',
  );
  assert.ok(calls.every((call) => call.command === 'git'));
  assert.deepEqual(fs.readdirSync(home), []);
});

test('venv and dependency failures leave no partial install and preserve existing installs', async () => {
  const repo = tempDir('decx-repo-');
  pythonCheckout(repo);
  for (const windows of [false, true]) {
    for (const existing of [false, true]) {
      for (const broken of ['venv', 'pip', 'verify']) {
        const home = tempDir('decx-home-');
        const prefix = path.join(home, 'share', 'droidasc');
        const binary = path.join(home, 'bin', windows ? 'droidasc.cmd' : 'droidasc');
        if (existing) {
          writeFile(path.join(prefix, 'PROVENANCE'), `tool: droidasc\nbinaries: ${path.basename(binary)}\n`);
          writeFile(path.join(home, 'runtime', 'droidasc', 'marker'), 'old environment');
          writeFile(binary, 'old launcher');
        }
        const calls: CommandSpec[] = [];
        await assert.rejects(
          () => installTool(shipped('droidasc'), { noLinks: true }, context(home, repo, 'http://127.0.0.1:9', pythonRunner(calls, broken, windows), windows ? 'win-amd64' : 'linux-amd64')),
          (error: unknown) => error instanceof InstallError && error.code === `${broken.toUpperCase()}_FAILED`,
        );
        assert.equal(calls.find((call) => call.args[1] === 'venv')?.args[2], path.join(home, 'runtime', 'droidasc'));
        assert.ok(calls.some((call) => call.args.includes('--help') || call.args.includes('install')) || broken === 'venv');
        assert.ok(!fs.readdirSync(home).some((name) => name.startsWith('.decx-')));
        if (existing) {
          assert.equal(fs.readFileSync(binary, 'utf8'), 'old launcher');
          assert.equal(fs.readFileSync(path.join(prefix, 'PROVENANCE'), 'utf8'), `tool: droidasc\nbinaries: ${path.basename(binary)}\n`);
          assert.equal(fs.readFileSync(path.join(home, 'runtime', 'droidasc', 'marker'), 'utf8'), 'old environment');
        } else {
          assert.equal(fs.existsSync(prefix), false);
          assert.equal(fs.existsSync(binary), false);
        }
      }
    }
  }
});

test('installed Python console script forwards arguments without a copied source tree', { skip: process.platform === 'win32' }, async () => {
  const home = tempDir('decx-home with spaces-');
  const repo = tempDir('decx-repo-');
  pythonCheckout(repo);
  const run: CommandRunner = (spec) => {
    if (spec.args[0] === '--version') return ok('Python 3.11.5\n');
    if (spec.args[0] === '-m' && spec.args[1] === 'venv') {
      writeFile(path.join(home, 'runtime', 'droidasc', 'bin', 'python'), '#!/bin/sh\n', 0o755);
    }
    return ok();
  };
  const installed = await installTool(shipped('droidasc'), { noLinks: true }, context(home, repo, 'http://127.0.0.1:9', run));
  const script = path.join(home, 'runtime', 'droidasc', 'bin', 'droidasc');
  writeFile(script, '#!/bin/sh\nprintf "%s\\n" "$@"\nexit 7\n', 0o755);
  const result = spawnSync(installed.launcher, ['two words', 'relative.apk'], { encoding: 'utf8' });
  assert.equal(result.status, 7);
  assert.equal(result.stdout, 'two words\nrelative.apk\n');
  assert.deepEqual(fs.readdirSync(installed.prefix), ['PROVENANCE']);
});

test('commit failures restore payload, specs, all store binaries and PROVENANCE', async (t) => {
  const fixture = releaseFixture();
  await withDemoServer({ [ASSET_PATH]: fixture.linuxTar, [SPECS_ASSET_PATH]: fixture.specsTar }, async (server) => {
    for (const existing of [false, true]) {
      for (const phase of ['specs', 'copy', 'mode', 'wrapper', 'packaged', 'stale', 'provenance']) {
        if ((!existing && phase === 'stale') || (process.platform === 'win32' && phase === 'mode')) continue;
        const home = tempDir('decx-home-');
        const prefix = path.join(home, 'share', 'demo');
        const binary = path.join(home, 'bin', 'demo');
        const stale = path.join(home, 'bin', 'old-demo');
        const provenance = 'tool: demo\nbinaries: demo old-demo\n';
        if (existing) {
          writeFile(path.join(prefix, 'PROVENANCE'), provenance);
          writeFile(path.join(prefix, 'specs', 'old.sla'), 'old specs');
          writeFile(binary, 'old binary', 0o755);
          writeFile(stale, 'old stale binary', 0o755);
        }
        const manifest = demoManifest({ extraAssets: { specs: 'demo-{version}-specs.tar.gz' } });
        if (phase === 'wrapper' || phase === 'packaged') manifest.env = { DEMO_SPECS: '{prefix}/specs' };
        let injected = false;
        const abort = () => { injected = true; throw new Error('injected commit failure'); };
        const rename = fs.renameSync;
        const copy = fs.copyFileSync;
        const write = fs.writeFileSync;
        const chmod = fs.chmodSync;
        t.mock.method(fs, 'chmodSync', (...args: Parameters<typeof fs.chmodSync>) => {
          if (!injected && phase === 'mode' && String(args[0]) === binary) abort();
          return chmod(...args);
        });
        t.mock.method(fs, 'renameSync', (...args: Parameters<typeof fs.renameSync>) => {
          const [from, to] = args.map(String);
          if (!injected && ((phase === 'specs' && to === path.join(prefix, 'specs')) ||
            (phase === 'packaged' && to === path.join(prefix, 'bin', 'demo')) ||
            (phase === 'stale' && from === stale))) abort();
          return rename(...args);
        });
        t.mock.method(fs, 'copyFileSync', (...args: Parameters<typeof fs.copyFileSync>) => {
          if (!injected && phase === 'copy' && String(args[1]) === binary) { write(binary, 'partial binary'); abort(); }
          return copy(...args);
        });
        t.mock.method(fs, 'writeFileSync', (...args: Parameters<typeof fs.writeFileSync>) => {
          const dest = String(args[0]);
          if (!injected && ((phase === 'wrapper' && dest === binary) || (phase === 'provenance' && dest === path.join(prefix, 'PROVENANCE')))) {
            write(...args); abort();
          }
          return write(...args);
        });
        try {
          await assert.rejects(() => installTool(manifest, { version: '1.0.0', noLinks: true }, context(home, tempDir('decx-repo-'), server.url, releaseRunner())), /injected commit failure/);
        } finally { t.mock.restoreAll(); }
        assert.ok(injected, phase);
        assert.ok(!fs.readdirSync(home).some((name) => name.startsWith('.decx-')));
        if (existing) {
          assert.equal(fs.readFileSync(binary, 'utf8'), 'old binary');
          assert.equal(fs.readFileSync(stale, 'utf8'), 'old stale binary');
          assert.equal(fs.readFileSync(path.join(prefix, 'PROVENANCE'), 'utf8'), provenance);
          assert.equal(fs.readFileSync(path.join(prefix, 'specs', 'old.sla'), 'utf8'), 'old specs');
          assert.equal(fs.existsSync(path.join(prefix, 'specs', 'all.sla')), false);
        } else {
          assert.equal(fs.existsSync(prefix), false);
          assert.equal(fs.existsSync(binary), false);
        }
      }
    }
  });
});

test('a real offline venv executes the installed console script after commit', async (t) => {
  const python = ['python3', 'python'].find((command) => spawnSync(command, ['-c', 'import venv, ensurepip'], { encoding: 'utf8' }).status === 0);
  if (python === undefined) { t.skip('Python with venv/ensurepip is not available'); return; }
  const home = tempDir('decx-real-venv-');
  const repo = tempDir('decx-repo-');
  pythonCheckout(repo);
  const windows = process.platform === 'win32';
  const run: CommandRunner = (spec) => {
    if (['git', 'uv', 'pipx'].includes(spec.command)) return fail();
    if (spec.args.includes('install') && spec.args.includes('pip')) {
      const bin = path.join(home, 'runtime', 'droidasc', windows ? 'Scripts' : 'bin');
      writeFile(path.join(bin, windows ? 'droidasc.exe' : 'droidasc'), windows ? 'MZ' : '#!/bin/sh\necho installed-console\n', 0o755);
      return ok();
    }
    const result = spawnSync(spec.command, spec.args, { encoding: 'utf8', timeout: 60_000 });
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', ...(result.error ? { error: result.error.message } : {}) };
  };
  const ctx = context(home, repo, 'http://127.0.0.1:9', run, windows ? 'win-amd64' : 'linux-amd64');
  ctx.env = { ...process.env, HOME: home, USERPROFILE: home, DECX_PYTHON: python };
  const manifest = { ...shipped('droidasc'), requires: { python: '>=3.8' } };
  const installed = await installTool(manifest, { noLinks: true }, ctx);
  assert.deepEqual(fs.readdirSync(installed.prefix), ['PROVENANCE']);
  if (!windows) {
    const result = spawnSync(installed.launcher, ['--version'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'installed-console');
  }
});

test('core PROVENANCE failure never creates PATH links', async (t) => {
  const home = tempDir('decx-home-');
  const links = path.join(home, 'path-links');
  const fixture = releaseFixture();
  const write = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', (...args: Parameters<typeof fs.writeFileSync>) => {
    if (String(args[0]) === provenanceFile(home, 'demo')) throw new Error('core record failure');
    return write(...args);
  });
  await withDemoServer({ [ASSET_PATH]: fixture.linuxTar }, async (server) => {
    await assert.rejects(() => installTool(demoManifest(), { version: '1.0.0', links }, context(home, tempDir('decx-repo-'), server.url, releaseRunner())), /core record failure/);
  });
  assert.equal(fs.existsSync(links), false);
  assert.equal(fs.existsSync(path.join(home, 'share', 'demo')), false);
  assert.equal(fs.existsSync(path.join(home, 'bin', 'demo')), false);
});

test('post-commit link creation and link record failures only warn and preserve core provenance', async (t) => {
  const fixture = releaseFixture();
  await withDemoServer({ [ASSET_PATH]: fixture.linuxTar }, async (server) => {
    for (const failure of ['creation', 'record']) {
      const home = tempDir('decx-home-');
      const links = path.join(home, 'path-links');
      const warnings: string[] = [];
      if (failure === 'creation') writeFile(links, 'not a directory');
      const write = fs.writeFileSync;
      t.mock.method(fs, 'writeFileSync', (...args: Parameters<typeof fs.writeFileSync>) => {
        if (failure === 'record' && String(args[0]).endsWith('PROVENANCE.links')) {
          write(...args); throw new Error('link record failure');
        }
        return write(...args);
      });
      try {
        const ctx = context(home, tempDir('decx-repo-'), server.url, releaseRunner());
        ctx.log = (line) => warnings.push(line);
        const installed = await installTool(demoManifest(), { version: '1.0.0', links }, ctx);
        assert.ok(fs.existsSync(installed.launcher));
        assert.match(provenanceText(home, 'demo'), /^tool: demo$/m);
        assert.equal(installed.provenance.links, undefined);
        assert.ok(!provenanceText(home, 'demo').includes('links:'));
        assert.ok(warnings.some((line) => line.startsWith('warning: installed demo')));
        assert.equal(fs.existsSync(path.join(installed.prefix, 'PROVENANCE.links')), false);
        if (failure === 'record') {
          assert.ok(installed.links!.some((link) => link.status === 'created' && fs.existsSync(link.path)));
        }
      } finally { t.mock.restoreAll(); }
    }
  });
});

test('tag and PATH helpers match the shell installers', () => {
  assert.equal(normalizeReleaseTag('1.504'), 'v1.504');
  assert.equal(normalizeReleaseTag('1.504', 'tools-v'), 'tools-v1.504');
  assert.equal(normalizeReleaseTag('tools-v0.1.0', 'tools-v'), 'tools-v0.1.0');
  assert.equal(releaseVersionFromTag('tools-v0.1.0', 'tools-v'), '0.1.0');
  assert.equal(releaseVersionFromTag('v1.504'), '1.504');

  const release = demoManifest().release;
  assert.ok(release !== undefined);
  assert.equal(releaseAssetName(release, 'linux-amd64', '1.0.0'), 'demo-1.0.0-linux-amd64.tar.gz');
  assert.equal(releaseAssetName(release, 'darwin-arm64', '1.0.0'), null);

  assert.match(pathHint('/opt/decx/bin', false), /^export PATH="\/opt\/decx\/bin:\$PATH"$/);
  assert.match(pathHint('C:\\decx\\bin', true), /^set PATH=C:\\decx\\bin;%PATH%$/);
  assert.match(
    venvLauncherText({ id: 'droidasc', platformOs: 'linux', venvBin: 'bin', command: 'droidasc' }),
    /exec "\$VIRTUAL_ENV\/bin\/droidasc" "\$@"/,
  );
  assert.match(venvCmdLauncherText({ id: 'droidasc', command: 'droidasc' }), /%VIRTUAL_ENV%\\Scripts\\droidasc\.exe/);
  assert.throws(() => envLauncherText('/bin/demo', { 'BAD;touch /tmp/x': 'x' }), /invalid launcher environment variable/);
  assert.throws(() => envCmdLauncherText('C:\\demo.exe', { SAFE: 'x" & echo injected' }), /cmd metacharacters/);
  assert.throws(() => envCmdLauncherText('C:\\demo.exe', { SAFE: '%COMSPEC%' }), /cmd metacharacters/);
});
