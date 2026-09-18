/**
 * Installer tests: release download + sha256 verification, per-platform asset
 * resolution, specs staging, venv installs, source builds and the CLI wiring.
 * Everything is offline: archives are built in-test and served by a local
 * node:http server; external programs run through an injected CommandRunner.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { provenanceFile } from '../src/config.ts';
import {
  InstallError,
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
import { loadManifests, type ReleaseSpec, type SourceSpec, type ToolManifest } from '../src/manifest.ts';
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

const LATEST_PATH = '/repos/acme/demo/releases/latest';
const ASSET_PATH = '/acme/demo/releases/download/v1.0.0/demo-1.0.0-linux-x64.tar.gz';
const WINDOWS_ASSET_PATH = '/acme/demo/releases/download/v1.0.0/demo-1.0.0-windows-x64.zip';
const SPECS_ASSET_PATH = '/acme/demo/releases/download/v1.0.0/demo-1.0.0-specs.tar.gz';
const CHECKSUMS_PATH = '/acme/demo/releases/download/v1.0.0/SHA256SUMS';

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
  return manifest;
}

interface DemoExtras {
  checksums?: string;
  extraAssets?: Record<string, string>;
  source?: SourceSpec;
}

function demoManifest(extras: DemoExtras = {}): ToolManifest {
  return {
    manifest: 1,
    id: 'demo',
    kind: 'binary',
    summary: 'demo tool for installer tests',
    launch: { bin: 'demo' },
    bins: ['demo'],
    release: {
      repository: 'acme/demo',
      assets: {
        'linux-x64': 'demo-{version}-linux-x64.tar.gz',
        'windows-x64': 'demo-{version}-windows-x64.zip',
      },
      ...(extras.checksums !== undefined ? { checksums: extras.checksums } : {}),
      ...(extras.extraAssets !== undefined ? { extraAssets: extras.extraAssets } : {}),
    },
    verify: { args: ['--version'] },
    ...(extras.source !== undefined ? { source: extras.source } : {}),
  };
}

/** The demo release with a pinned version, for the pin/override tests. */
function pinnedRelease(version: string): ReleaseSpec {
  const release = demoManifest().release;
  if (release === undefined) {
    throw new Error('demo manifest lost its release spec');
  }
  return { ...release, version };
}

function context(
  home: string,
  repoRoot: string,
  url: string,
  run: CommandRunner,
  platform: PlatformKey = 'linux-x64',
  verify?: boolean,
): InstallContext {
  return {
    home,
    repoRoot,
    env: homeEnv(home),
    platform,
    apiBase: url,
    downloadBase: url,
    log: () => {},
    run,
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
): Promise<T> {
  const server = await startFixtureServer(routes);
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
      [CHECKSUMS_PATH]: Buffer.from(`${sha256(fixture.linuxTar)}  demo-1.0.0-linux-x64.tar.gz\n`),
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
      assert.equal(result.asset, 'demo-1.0.0-linux-x64.tar.gz');
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
      assert.match(provenance, /^platform: linux-x64$/m);
      assert.match(provenance, /^release_asset: demo-1\.0\.0-linux-x64\.tar\.gz$/m);
      assert.match(provenance, new RegExp(`^sha256: ${sha256(fixture.linuxTar)}$`, 'm'));
      assert.match(provenance, /^build: prebuilt archive v1\.0\.0$/m);
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
      [CHECKSUMS_PATH]: Buffer.from(`${'0'.repeat(64)}  demo-1.0.0-linux-x64.tar.gz\n`),
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

test('a missing checksum asset only downgrades the verification result', async () => {
  const home = tempDir('decx-home-');
  const repoRoot = tempDir('decx-repo-');
  const fixture = releaseFixture();
  await withDemoServer({ [ASSET_PATH]: fixture.linuxTar }, async (server) => {
    const result = await installTool(
      demoManifest({ checksums: 'SHA256SUMS' }),
      { version: '1.0.0' },
      context(home, repoRoot, server.url, releaseRunner()),
    );
    assert.match(result.checksum ?? '', /^not verified \(SHA256SUMS not found\)$/);
    assert.ok(fs.existsSync(result.launcher));
  });
});

test('install without --version resolves the newest stable release through the API', async () => {
  const home = tempDir('decx-home-');
  const repoRoot = tempDir('decx-repo-');
  const fixture = releaseFixture();
  await withDemoServer(
    {
      [LATEST_PATH]: Buffer.from(JSON.stringify({ tag_name: 'v1.0.0', prerelease: false, draft: false })),
      [ASSET_PATH]: fixture.linuxTar,
    },
    async (server) => {
      const result = await installTool(demoManifest(), {}, context(home, repoRoot, server.url, releaseRunner()));
      assert.equal(result.releaseTag, 'v1.0.0');
      assert.ok(server.requested.includes(LATEST_PATH));
    },
  );
});

test('a pinned manifest resolves that exact release without asking for the newest', async () => {
  const home = tempDir('decx-home-');
  const repoRoot = tempDir('decx-repo-');
  const fixture = releaseFixture();
  await withDemoServer(
    {
      [LATEST_PATH]: Buffer.from(JSON.stringify({ tag_name: 'v2.0.0', prerelease: false, draft: false })),
      [ASSET_PATH]: fixture.linuxTar,
    },
    async (server) => {
      const manifest: ToolManifest = { ...demoManifest(), release: { ...pinnedRelease('1.0.0') } };
      const result = await installTool(manifest, {}, context(home, repoRoot, server.url, releaseRunner()));
      assert.equal(result.releaseTag, 'v1.0.0');
      // The pinned tag is the contract the asset names were verified against, so
      // nothing about the newest release is even looked up.
      assert.ok(!server.requested.includes(LATEST_PATH));
    },
  );
});

test('an explicit --version overrides the manifest pin', async () => {
  const home = tempDir('decx-home-');
  const repoRoot = tempDir('decx-repo-');
  const fixture = releaseFixture();
  const v2AssetPath = '/acme/demo/releases/download/v2.0.0/demo-2.0.0-linux-x64.tar.gz';
  await withDemoServer(
    {
      [LATEST_PATH]: Buffer.from(JSON.stringify({ tag_name: 'v2.0.0', prerelease: false, draft: false })),
      [v2AssetPath]: fixture.linuxTar,
    },
    async (server) => {
      const manifest: ToolManifest = { ...demoManifest(), release: { ...pinnedRelease('1.0.0') } };
      const result = await installTool(
        manifest,
        { version: '2.0.0' },
        context(home, repoRoot, server.url, releaseRunner([], ok('demo 2.0.0\n'))),
      );
      assert.equal(result.releaseTag, 'v2.0.0');
      assert.equal(result.asset, 'demo-2.0.0-linux-x64.tar.gz');
      assert.ok(server.requested.includes(v2AssetPath));
      assert.ok(!server.requested.includes(LATEST_PATH));
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
      context(home, repoRoot, server.url, releaseRunner([], ok('demo 1.0.0\n')), 'windows-x64'),
    );
    assert.equal(result.asset, 'demo-1.0.0-windows-x64.zip');
    assert.deepEqual(result.binaries, ['demo.exe']);
    assert.ok(result.launcher.endsWith('demo.exe'));
    assert.ok(fs.existsSync(result.launcher));
    assert.match(provenanceText(home, 'demo'), /^platform: windows-x64$/m);
  });
});

test('an unsupported platform fails before downloading', async () => {
  const home = tempDir('decx-home-');
  const repoRoot = tempDir('decx-repo-');
  await assert.rejects(
    () => installTool(demoManifest(), { version: '1.0.0' }, context(home, repoRoot, 'http://127.0.0.1:9', releaseRunner(), 'macos-arm64')),
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
      context(uncheckedHome, repoRoot, server.url, releaseRunner([], fail('bad binary')), 'linux-x64', false),
    );
    assert.ok(fs.existsSync(result.launcher));
  });
});

test('droidasc installs a private venv with a pass-through POSIX launcher', async () => {
  const home = tempDir('decx-home-');
  const repoRoot = tempDir('decx-repo-');
  const source = path.join(repoRoot, 'subprojects', 'decx-droidasc', 'source');
  writeFile(path.join(source, 'main.py'), 'print("droidasc")\n');
  writeFile(path.join(source, 'droidasc', 'cli.py'), 'VALUE = 1\n');
  writeFile(path.join(source, 'requirements.txt'), 'flask==3.0.0\n');
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

  const result = await installTool(shipped('droidasc'), {}, context(home, repoRoot, 'http://127.0.0.1:9', run));
  assert.equal(result.method, 'python venv');
  assert.deepEqual(result.binaries, ['droidasc']);
  const launcher = path.join(home, 'bin', 'droidasc');
  assert.equal(
    fs.readFileSync(launcher, 'utf8'),
    venvLauncherText({ id: 'droidasc', platformOs: 'linux', venvBin: 'bin', venvPython: 'python', entry: 'main.py' }),
  );
  assert.ok(fs.existsSync(path.join(home, 'share', 'droidasc', 'droidasc', 'cli.py')));

  const pip = calls.find((args) => args.includes('-m') && args.includes('pip'));
  assert.ok(pip !== undefined);
  assert.ok(pip.includes('--disable-pip-version-check'));
  assert.ok(pip.includes('-r'));
  assert.ok((pip[pip.length - 1] ?? '').endsWith(path.join('share', 'droidasc', 'requirements.txt')));

  const provenance = provenanceText(home, 'droidasc');
  assert.match(provenance, /^install_method: python venv$/m);
  assert.match(provenance, /^requirements: flask==3\.0\.0$/m);
  assert.match(provenance, /^python: Python 3\.11\.5 \(python3\)$/m);
  assert.match(provenance, /^platform: linux-x64$/m);
  assert.match(provenance, new RegExp(`^venv: ${path.join(home, 'share', 'droidasc', 'venv', 'bin', 'python').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
});

test('a too-old default python3 is skipped in favour of a versioned interpreter', async () => {
  const home = tempDir('decx-home-');
  const repoRoot = tempDir('decx-repo-');
  const source = path.join(repoRoot, 'subprojects', 'decx-droidasc', 'source');
  writeFile(path.join(source, 'main.py'), 'print("droidasc")\n');
  writeFile(path.join(source, 'droidasc', 'cli.py'), 'VALUE = 1\n');
  writeFile(path.join(source, 'requirements.txt'), 'flask==3.0.0\n');
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

  const result = await installTool(shipped('droidasc'), {}, context(home, repoRoot, 'http://127.0.0.1:9', run));
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
    () => installTool(shipped('droidasc'), {}, context(stale, repoRoot, 'http://127.0.0.1:9', staleRun)),
    (error: unknown) => error instanceof InstallError && error.code === 'PYTHON_TOO_OLD',
  );
  assert.equal(fs.existsSync(path.join(stale, 'share', 'droidasc', 'PROVENANCE')), false, 'nothing is recorded');
});

test('droidasc on Windows creates the cmd launcher and uses Scripts/python.exe', async () => {
  const home = tempDir('decx-home-');
  const repoRoot = tempDir('decx-repo-');
  const source = path.join(repoRoot, 'subprojects', 'decx-droidasc', 'source');
  writeFile(path.join(source, 'main.py'), 'print("droidasc")\n');
  writeFile(path.join(source, 'droidasc', 'cli.py'), 'VALUE = 1\n');
  writeFile(path.join(source, 'requirements.txt'), 'flask==3.0.0\n');
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

  const result = await installTool(shipped('droidasc'), {}, context(home, repoRoot, 'http://127.0.0.1:9', run, 'windows-x64'));
  assert.ok(result.launcher.endsWith(path.join('bin', 'droidasc.cmd')));
  assert.equal(
    fs.readFileSync(result.launcher, 'utf8'),
    venvCmdLauncherText({ id: 'droidasc', entry: 'main.py' }),
  );
  assert.match(provenanceText(home, 'droidasc'), /^platform: windows-x64$/m);
  assert.match(provenanceText(home, 'droidasc'), /Scripts[\\/]python\.exe$/m);
});

test('afe builds the vendored checkout with cargo and records the toolchain', async () => {
  const home = tempDir('decx-home-');
  const repoRoot = tempDir('decx-repo-');
  writeFile(
    path.join(repoRoot, 'subprojects', 'decx-afe', 'Cargo.toml'),
    '[package]\nname = "afe"\nversion = "5.0.0"\n',
  );
  let buildArgs: string[] = [];
  const run: CommandRunner = (spec) => {
    if (spec.command === 'cargo' && spec.args[0] === '--version') {
      return ok('cargo 1.90.0 (fake)\n');
    }
    if (spec.command === 'rustc') {
      return ok('rustc 1.90.0 (fake)\n');
    }
    if (spec.command === 'cargo' && spec.args[0] === 'build') {
      buildArgs = spec.args;
      const target = spec.args[spec.args.indexOf('--target-dir') + 1];
      if (target === undefined) {
        throw new Error('cargo build ran without --target-dir');
      }
      writeFile(path.join(target, 'release', 'afe'), '#!/bin/sh\n', 0o755);
      return ok();
    }
    if (spec.command === 'git') {
      if (spec.args.includes('--abbrev-ref')) {
        return ok('dev\n');
      }
      if (spec.args.includes('--verify')) {
        return ok('ghi789\n');
      }
      const dir = spec.args[1];
      return ok(`${dir === repoRoot ? 'abc123' : 'def456'}\n`);
    }
    return fail();
  };

  const result = await installTool(
    shipped('afe'),
    { fromSource: true },
    context(home, repoRoot, 'http://127.0.0.1:9', run, 'linux-x64', false),
  );
  assert.equal(result.method, 'source build');
  assert.equal(result.version, '5.0.0');
  assert.ok(fs.existsSync(path.join(home, 'bin', 'afe')));
  assert.ok(buildArgs.includes('--release'));
  assert.ok(buildArgs.includes('-p') && buildArgs.includes('afe'));
  assert.ok(buildArgs.includes('--target-dir') && buildArgs.includes('--manifest-path'));
  assert.equal(buildArgs.includes('--offline'), false);

  const provenance = provenanceText(home, 'afe');
  assert.match(provenance, /^install_method: source build$/m);
  assert.match(provenance, /^crate_version: 5\.0\.0$/m);
  assert.match(provenance, /^repository_revision: abc123$/m);
  assert.match(provenance, /^repository_branch: dev$/m);
  assert.match(provenance, /^upstream_revision: def456$/m);
  assert.match(provenance, /^superproject_gitlink: ghi789$/m);
  assert.match(provenance, /^rustc: rustc 1\.90\.0 \(fake\)$/m);
  assert.match(provenance, /^cargo: cargo 1\.90\.0 \(fake\)$/m);
});

test('a source build bakes the manifest build environment and reports the checkout tag', async () => {
  // A manifest can carry a build-time version variable for an upstream whose
  // release CI bakes one into the binaries (Kuna used KUNA_VERSION, see upstream
  // docs/release.md); it has to resolve against the tag the checkout sits on.
  const home = tempDir('decx-home-');
  const repoRoot = tempDir('decx-repo-');
  writeFile(path.join(repoRoot, 'vendor', 'demo', 'Cargo.toml'), '[workspace]\nmembers = []\n');
  writeFile(path.join(repoRoot, 'vendor', 'demo', 'VERSION'), '1\n');
  let buildSpec: CommandSpec | undefined;
  const run: CommandRunner = (spec) => {
    if (spec.command === 'cargo' && spec.args[0] === '--version') {
      return ok('cargo 1.93.0 (fake)\n');
    }
    if (spec.command === 'rustc') {
      return ok('rustc 1.93.0 (fake)\n');
    }
    if (spec.command === 'cargo' && spec.args[0] === 'build') {
      buildSpec = spec;
      const target = spec.args[spec.args.indexOf('--target-dir') + 1];
      if (target === undefined) {
        throw new Error('cargo build ran without --target-dir');
      }
      writeFile(path.join(target, 'release', 'demo'), '#!/bin/sh\n', 0o755);
      return ok();
    }
    if (spec.command === 'git') {
      if (spec.args.includes('describe')) {
        return ok('v2.0.0\n');
      }
      if (spec.args.includes('--abbrev-ref')) {
        return ok('main\n');
      }
      return ok('abc123\n');
    }
    return fail();
  };
  const manifest = demoManifest({
    source: {
      path: 'vendor/demo',
      build: { manifest: 'Cargo.toml', packages: ['demo'], env: { DEMO_VERSION: '{version}' } },
    },
  });

  const result = await installTool(
    manifest,
    { fromSource: true },
    context(home, repoRoot, 'http://127.0.0.1:9', run, 'linux-x64', false),
  );
  assert.equal(result.method, 'source build');
  assert.equal(result.version, '2.0.0');
  assert.equal(buildSpec?.env?.DEMO_VERSION, '2.0.0');

  const provenance = provenanceText(home, 'demo');
  assert.match(provenance, /^install_method: source build$/m);
  assert.match(provenance, /^upstream_tag: v2\.0\.0$/m);
  assert.match(provenance, /^crate_version: unknown$/m);
  assert.match(provenance, /^upstream_version_file: 1$/m);
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
        context(home, repoRoot, server.url, releaseRunner(), 'linux-x64', false),
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
    assert.ok(fs.existsSync(provenanceFile(home, 'demo')));
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
      context(home, repoRoot, server.url, releaseRunner(), 'linux-x64', false),
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

test('CLI run takes --home before the tool id and forwards the rest verbatim', () => {
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

  const forwarded = runCli(['run', '--home', home, '--subprojects', subprojectsDir, 'demo', '--home', '/tmp/elsewhere']);
  assert.equal(forwarded.status, 7);
  assert.match(fs.readFileSync(probe, 'utf8'), /--home \/tmp\/elsewhere/);
});

test('CLI help covers the installer commands', () => {
  const help = runCli(['install', '--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /usage: decx install <tool>/);
  assert.match(help.stdout, /--from-source/);

  const runUsage = runCli(['run']);
  assert.equal(runUsage.status, 2);
  assert.equal((runUsage.json as { error: { code: string } }).error.code, 'USAGE');

  const unknown = runCli(['help', 'nope']);
  assert.equal(unknown.status, 2);
});

test('tag and PATH helpers match the shell installers', () => {
  assert.equal(normalizeReleaseTag('1.504'), 'v1.504');
  assert.equal(normalizeReleaseTag('1.504', 'tools-v'), 'tools-v1.504');
  assert.equal(normalizeReleaseTag('tools-v0.1.0', 'tools-v'), 'tools-v0.1.0');
  assert.equal(releaseVersionFromTag('tools-v0.1.0', 'tools-v'), '0.1.0');
  assert.equal(releaseVersionFromTag('v1.504'), '1.504');

  const release = demoManifest().release;
  assert.ok(release !== undefined);
  assert.equal(releaseAssetName(release, 'linux-x64', '1.0.0'), 'demo-1.0.0-linux-x64.tar.gz');
  assert.equal(releaseAssetName(release, 'macos-arm64', '1.0.0'), null);

  assert.match(pathHint('/opt/decx/bin', false), /^export PATH="\/opt\/decx\/bin:\$PATH"$/);
  assert.match(pathHint('C:\\decx\\bin', true), /^set PATH=C:\\decx\\bin;%PATH%$/);
  assert.match(
    venvLauncherText({ id: 'droidasc', platformOs: 'linux', venvBin: 'bin', venvPython: 'python', entry: 'main.py' }),
    /exec "\$root\/share\/droidasc\/venv\/bin\/python" "\$root\/share\/droidasc\/main\.py" "\$@"/,
  );
  assert.match(venvCmdLauncherText({ id: 'droidasc', entry: 'main.py' }), /share\\droidasc\\venv\\Scripts\\python\.exe/);
});
