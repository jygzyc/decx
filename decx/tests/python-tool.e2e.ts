import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runCli, runCliAsync, tempDir } from './fixtures.ts';
import { writePythonWheel } from './python-wheel.ts';

const fixtureDir = fileURLToPath(new URL('./fixtures/python-tool/', import.meta.url));
const manifestFile = path.join(fixtureDir, 'decx-pyprobe.json');

test('Python fixture installs a local wheel into a real private venv and runs through decx -m', async (t) => {
  const home = tempDir('decx-py-home-');
  const wheelhouse = tempDir('decx-py-wheels-');
  const repoRoot = tempDir('decx-py-repo-');
  t.after(() => {
    for (const dir of [home, wheelhouse, repoRoot]) fs.rmSync(dir, { recursive: true, force: true });
  });
  const thirdParty = path.join(repoRoot, 'third_party');
  const subproject = path.join(thirdParty, 'decx-pyprobe');
  fs.mkdirSync(subproject, { recursive: true });
  fs.copyFileSync(manifestFile, path.join(subproject, 'decx-pyprobe.json'));
  writePythonWheel(wheelhouse);

  // These are pip's offline switches, not an installer shortcut: DECX still
  // creates the venv, invokes its pip and verifies its generated console script.
  const env = {
    ...process.env,
    HOME: repoRoot,
    USERPROFILE: repoRoot,
    XDG_CACHE_HOME: path.join(home, 'cache'),
    PIP_CACHE_DIR: path.join(home, 'pip-cache'),
    PIP_CONFIG_FILE: os.devNull,
    PIP_NO_INDEX: '1',
    PIP_FIND_LINKS: wheelhouse,
    PIP_DISABLE_PIP_VERSION_CHECK: '1',
    PYTHONPATH: '',
    PYTHONIOENCODING: 'utf-8',
  };
  const linkDir = path.join(home, 'links');
  const installed = await runCliAsync(['--home', home, '--third-party', thirdParty, 'install', 'pyprobe', '--version', '1.0.0', '--links', linkDir], env);
  assert.equal(installed.status, 0, installed.stderr + installed.stdout);
  const result = installed.json as { method: string; version: string; launcher: string };
  assert.equal(result.method, 'python venv');
  assert.equal(result.version, '1.0.0');
  const scriptsDir = process.platform === 'win32' ? 'Scripts' : 'bin';
  const executable = process.platform === 'win32' ? 'pyprobe.exe' : 'pyprobe';
  const venvScript = path.join(home, 'runtime', 'pyprobe', scriptsDir, executable);
  assert.ok(fs.existsSync(venvScript));
  assert.ok(fs.existsSync(result.launcher));
  const linked = path.join(linkDir, process.platform === 'win32' ? 'pyprobe.cmd' : 'pyprobe');
  assert.ok(fs.existsSync(linked));
  if (process.platform !== 'win32') {
    const viaLink = spawnSync(linked, ['from PATH'], { encoding: 'utf8', env });
    assert.equal(viaLink.status, 0, viaLink.stderr);
    assert.deepEqual(JSON.parse(viaLink.stdout.trim()), ['from PATH']);
  }

  const args = ['two words', '中文', '--home', 'a"b'];
  const invoked = runCli(['--home', home, '--third-party', thirdParty, '-m', 'pyprobe', ...args], env);
  assert.equal(invoked.status, 0, invoked.stderr);
  assert.deepEqual(JSON.parse(invoked.stdout.trim()), args);
  const help = runCli(['--home', home, '--third-party', thirdParty, '-m', 'pyprobe', '--help'], env);
  assert.equal(help.status, 0, help.stderr);
  assert.equal(help.stdout.trim(), 'usage: pyprobe [arguments...]');
  const version = runCli(['--home', home, '--third-party', thirdParty, '-m', 'pyprobe', '--version'], env);
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), 'pyprobe 1.0.0');

  // Routing uses the executable descriptor, never a generated shell shim.
  const launcher = fs.readFileSync(result.launcher);
  fs.writeFileSync(result.launcher, 'this shim must not execute');
  const direct = runCli(['--home', home, '--third-party', thirdParty, '-m', 'pyprobe', ...args], env);
  assert.equal(direct.status, 0, direct.stderr);
  assert.deepEqual(JSON.parse(direct.stdout), args);
  fs.writeFileSync(result.launcher, launcher);

  const entry = path.join(home, 'share/pyprobe/launch.json');
  const descriptor = fs.readFileSync(entry);
  fs.unlinkSync(entry);
  const missing = runCli(['--home', home, '--third-party', thirdParty, '-m', 'pyprobe'], env);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stdout, /reinstall pyprobe/);
  fs.writeFileSync(entry, descriptor);

  // Failure occurs after swapping the payload and creating the new final-path venv.
  const provenance = path.join(home, 'share/pyprobe/PROVENANCE');
  const record = fs.readFileSync(provenance);
  const failed = await runCliAsync(['--home', home, '--third-party', thirdParty, 'update', 'pyprobe', '--version', '2.0.0'], env);
  assert.notEqual(failed.status, 0);
  assert.match(failed.stdout, /PIP_FAILED/);
  assert.deepEqual(fs.readFileSync(provenance), record);
  assert.deepEqual(fs.readFileSync(entry), descriptor);
  const restored = runCli(['--home', home, '--third-party', thirdParty, '-m', 'pyprobe', '--version'], env);
  assert.equal(restored.status, 0, restored.stderr);
  assert.equal(restored.stdout.trim(), 'pyprobe 1.0.0');
});
