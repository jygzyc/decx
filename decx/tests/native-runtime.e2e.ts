import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { currentPlatformKey } from '../src/platform.ts';
import { makeTarGz, makeZip, sha256, startFixtureServer, tempDir, writeFile } from './fixtures.ts';
import { writePythonWheel } from './python-wheel.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const host = `${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`;
const binary = path.join(root, 'dist', `decx-${host}${process.platform === 'win32' ? '.exe' : ''}`);

interface NativeResult { status: number | null; stdout: string; stderr: string }

function runNative(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<NativeResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, env, stdio: 'pipe', timeout: 60_000, killSignal: 'SIGKILL' });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', status => resolve({ status, stdout, stderr }));
  });
}

for (const suffix of process.platform === 'win32' ? ['zip'] : ['tar.gz', 'zip']) {
test(`native manager ${suffix}: install, argv/env, update, rollback and remove offline without Node`, {
  timeout: 120_000,
}, async (t) => {
  assert.ok(fs.existsSync(binary), 'build:scriptc must run before test:native');
  const temporary = tempDir('decx-native-');
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const home = path.join(temporary, 'install with spaces 中文');
  const links = path.join(temporary, 'links with spaces');
  const projects = path.join(temporary, 'subprojects');
  const emptyPath = path.join(temporary, 'empty-path');
  fs.mkdirSync(emptyPath);
  const name = process.platform === 'win32' ? 'demo.exe' : 'demo';
  const fixture = path.join(temporary, name);
  const source = path.join(temporary, 'demo.ts');
  writeFile(source, `
if (process.argv[2] === '--version') console.log('demo 1.0.0');
else {
  console.log(JSON.stringify({args:process.argv.slice(2), home:process.env.DECX_HOME, marker:process.env.DECX_NATIVE_MARKER}));
  console.error('fixture stderr');
  process.exit(7);
}
`);
  const compileScript = path.join(root, 'scripts/scriptc.mjs');
  const compiled = spawnSync(process.execPath, [compileScript, 'tool', source, '-o', fixture, '--no-keep-llvm'], { encoding: 'utf8', timeout: 90_000 });
  assert.equal(compiled.status, 0, compiled.stderr);
  const packFixture = (): Buffer => {
    const bytes = fs.readFileSync(fixture);
    return suffix === 'zip'
      ? makeZip([{ name, data: bytes, mode: 0o755 }])
      : makeTarGz([{ name, data: bytes, mode: 0o755 }, { name: 'alias', type: 'symlink', link: 'demo' }]);
  };
  const archive = packFixture();
  writeFile(source, fs.readFileSync(source, 'utf8').replace('demo 1.0.0', 'demo 1.1.0'));
  const compiledUpdate = spawnSync(process.execPath, [compileScript, 'tool', source, '-o', fixture, '--no-keep-llvm'], { encoding: 'utf8', timeout: 90_000 });
  assert.equal(compiledUpdate.status, 0, compiledUpdate.stderr);
  const updatedArchive = packFixture();
  const routes: Record<string, Buffer | string> = {};
  for (const version of ['1.0.0', '1.1.0', '1.2.0', '2.0.0']) {
    const directory = `/acme/demo/releases/download/v${version}`;
    const asset = `demo-${version}.${suffix}`;
    const data = version === '1.1.0' ? updatedArchive : archive;
    routes[`${directory}/${asset}`] = data;
    routes[`${directory}/SHA256SUMS`] = `${version === '2.0.0' ? '0'.repeat(64) : sha256(data)}  ${asset}\n`;
  }
  const releaseList = JSON.stringify([{ tag_name: 'v1.1.0', prerelease: false, draft: false }]);
  const redirected = await startFixtureServer({ '/releases': releaseList });
  t.after(() => redirected.close());
  routes['/repos/acme/demo/releases'] = '';
  const server = await startFixtureServer(routes, { '/repos/acme/demo/releases': 302 }, {
    '/repos/acme/demo/releases': { location: `${redirected.url}/releases` },
  });
  t.after(() => server.close());
  writeFile(path.join(projects, 'decx-demo/decx-demo.json'), JSON.stringify({
    manifest: 2, id: 'demo', summary: 'offline native fixture', install: ['github-release'],
    launch: { type: 'bin', commands: ['demo'] },
    env: { DECX_NATIVE_MARKER: 'launcher环境' },
    release: {repository:'acme/demo', tagPrefix:'v', assets:{[currentPlatformKey()!]:`demo-{version}.${suffix}`}, checksums:'SHA256SUMS'},
    verify: '--version',
  }));
  const env = {
    ...process.env, HOME: temporary, USERPROFILE: temporary, PATH: emptyPath, Path: emptyPath,
    DECX_HOME: home, DECX_LINKS_DIR: links, DECX_NATIVE_MARKER: '环境变量', GITHUB_TOKEN: 'fixture-secret',
    DECX_GITHUB_API_BASE: server.url, DECX_GITHUB_DOWNLOAD_BASE: server.url,
  };
  const execute = (args: string[]): Promise<NativeResult> => runNative(['--subprojects', projects, ...args], temporary, env);
  const installed = await execute(['install', 'demo', '--version', '1.0.0']);
  assert.equal(installed.status, 0, JSON.stringify(installed));
  assert.equal(JSON.parse(installed.stdout).ok, true);
  const provenance = path.join(home, 'share/demo/PROVENANCE');
  const original = fs.readFileSync(provenance, 'utf8');
  const argv = ['', 'two words', '中文', 'a"b', 'trailing\\', '&|<>^', '--home'];
  const tool = await execute(['-m', 'demo', ...argv]);
  assert.equal(tool.status, 7, JSON.stringify(tool));
  assert.match(tool.stderr, /fixture stderr/);
  assert.deepEqual(JSON.parse(tool.stdout), {args:argv, home, marker:'launcher环境'});
  const rejected = await execute(['update', 'demo', '--version', '2.0.0']);
  assert.equal(rejected.status, 1, JSON.stringify(rejected));
  assert.equal(JSON.parse(rejected.stdout).error.code, 'CHECKSUM_MISMATCH');
  assert.equal(fs.readFileSync(provenance, 'utf8'), original);
  const rollback = await execute(['update', 'demo', '--version', '1.2.0']);
  assert.equal(rollback.status, 1, JSON.stringify(rollback));
  assert.equal(JSON.parse(rollback.stdout).error.code, 'VERSION_MISMATCH');
  assert.equal(fs.readFileSync(provenance, 'utf8'), original);
  const afterRollback = await execute(['-m', 'demo', '--version']);
  assert.equal(afterRollback.status, 0, JSON.stringify(afterRollback));
  assert.equal(afterRollback.stdout.trim(), 'demo 1.0.0');
  const updated = await execute(['update', 'demo']);
  assert.equal(updated.status, 0, JSON.stringify(updated));
  assert.match(fs.readFileSync(provenance, 'utf8'), /release_tag: v1\.1\.0/);
  assert.ok(redirected.requested.includes('/releases'), 'native transport must follow the explicit redirect');
  assert.deepEqual(redirected.authorizations, [undefined], 'credentials must not cross origins');
  assert.ok(server.authorizations.includes('Bearer fixture-secret'));
  const removed = await execute(['remove', 'demo']);
  assert.equal(removed.status, 0, JSON.stringify(removed));
  assert.equal(fs.existsSync(provenance), false);
  assert.equal(fs.existsSync(path.join(links, process.platform === 'win32' ? 'demo.cmd' : 'demo')), false);
});
}

test('native manager creates a real Python venv offline and launches its entry point without Node', {
  timeout: 120_000,
}, async (t) => {
  const temporary = tempDir('decx-native-python-');
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const home = path.join(temporary, 'install with spaces');
  const wheelhouse = path.join(temporary, 'wheels');
  const projects = path.join(temporary, 'subprojects');
  const links = path.join(temporary, 'links');
  fs.mkdirSync(wheelhouse);
  writePythonWheel(wheelhouse);
  const manifest = fileURLToPath(new URL('./fixtures/python-tool/decx-pyprobe.json', import.meta.url));
  writeFile(path.join(projects, 'decx-pyprobe/decx-pyprobe.json'), fs.readFileSync(manifest));
  const python = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' });
  assert.equal(python.status, 0, python.stderr);
  const executable = python.stdout.trim();
  let pythonPath = path.dirname(executable);
  if (process.platform !== 'win32') {
    pythonPath = path.join(temporary, 'python-bin');
    fs.mkdirSync(pythonPath);
    for (const name of ['python', 'python3']) fs.symlinkSync(executable, path.join(pythonPath, name));
  }
  assert.equal(fs.existsSync(path.join(pythonPath, process.platform === 'win32' ? 'node.exe' : 'node')), false,
    'Python-only PATH must not contain Node');
  const env = {
    ...process.env, HOME: temporary, USERPROFILE: temporary, PATH: pythonPath, Path: pythonPath,
    DECX_HOME: home, DECX_LINKS_DIR: links, PIP_NO_INDEX: '1', PIP_FIND_LINKS: wheelhouse,
    PIP_CONFIG_FILE: os.devNull, PIP_CACHE_DIR: path.join(temporary, 'pip-cache'),
    PIP_DISABLE_PIP_VERSION_CHECK: '1', PYTHONPATH: '', PYTHONIOENCODING: 'utf-8',
  };
  const execute = (args: string[]): Promise<NativeResult> => runNative(['--subprojects', projects, ...args], temporary, env);
  const installed = await execute(['install', 'pyprobe', '--version', '1.0.0']);
  assert.equal(installed.status, 0, JSON.stringify(installed));
  assert.equal(JSON.parse(installed.stdout).method, 'python venv');
  const argv = ['', 'two words', '中文', 'a"b', 'trailing\\', '&|<>^', '%PATH%', '!bang!', '(parens)'];
  const invoked = await execute(['-m', 'pyprobe', ...argv]);
  assert.equal(invoked.status, 0, JSON.stringify(invoked));
  assert.deepEqual(JSON.parse(invoked.stdout.trim()), argv);
  const removed = await execute(['remove', 'pyprobe']);
  assert.equal(removed.status, 0, JSON.stringify(removed));
  assert.equal(fs.existsSync(path.join(home, 'runtime/pyprobe')), false);
});
