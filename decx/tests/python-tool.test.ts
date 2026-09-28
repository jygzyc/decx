import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { installTool } from '../src/install.ts';
import { validateManifest, type ToolManifest } from '../src/manifest.ts';
import { makeZip, runCli, tempDir } from './fixtures.ts';

const fixtureDir = fileURLToPath(new URL('./fixtures/python-tool/', import.meta.url));
const manifestFile = path.join(fixtureDir, 'decx-pyprobe.json');

function pythonManifest(): ToolManifest {
  const { manifest, errors } = validateManifest(JSON.parse(fs.readFileSync(manifestFile, 'utf8')), manifestFile, 'pyprobe');
  assert.deepEqual(errors, []);
  assert.ok(manifest);
  return manifest;
}

/** A minimal pure-Python wheel, built in memory; pip only sees this local wheelhouse. */
function writeWheel(wheelhouse: string): void {
  const info = 'pyprobe-1.0.0.dist-info';
  const files = [
    { name: 'pyprobe/__init__.py', data: fs.readFileSync(path.join(fixtureDir, 'pyprobe', '__init__.py')) },
    { name: 'pyprobe/cli.py', data: fs.readFileSync(path.join(fixtureDir, 'pyprobe', 'cli.py')) },
    { name: `${info}/METADATA`, data: 'Metadata-Version: 2.1\nName: pyprobe\nVersion: 1.0.0\n' },
    { name: `${info}/WHEEL`, data: 'Wheel-Version: 1.0\nGenerator: decx-test\nRoot-Is-Purelib: true\nTag: py3-none-any\n' },
    { name: `${info}/entry_points.txt`, data: '[console_scripts]\npyprobe = pyprobe.cli:main\n' },
  ];
  const record = [...files.map(({ name }) => `${name},,`), `${info}/RECORD,,`].join('\n') + '\n';
  fs.writeFileSync(path.join(wheelhouse, 'pyprobe-1.0.0-py3-none-any.whl'), makeZip([...files, { name: `${info}/RECORD`, data: record }]));
}

test('Python fixture installs a local wheel into a real private venv and runs through decx -m', async (t) => {
  const home = tempDir('decx-py-home-');
  const wheelhouse = tempDir('decx-py-wheels-');
  const repoRoot = tempDir('decx-py-repo-');
  t.after(() => {
    for (const dir of [home, wheelhouse, repoRoot]) fs.rmSync(dir, { recursive: true, force: true });
  });
  const subprojects = path.join(repoRoot, 'subprojects');
  const subproject = path.join(subprojects, 'decx-pyprobe');
  fs.mkdirSync(subproject, { recursive: true });
  fs.copyFileSync(manifestFile, path.join(subproject, 'decx-pyprobe.json'));
  writeWheel(wheelhouse);

  // These are pip's offline switches, not an installer shortcut: DECX still
  // creates the venv, invokes its pip and verifies its generated console script.
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CACHE_HOME: path.join(home, 'cache'),
    PIP_CACHE_DIR: path.join(home, 'pip-cache'),
    PIP_CONFIG_FILE: os.devNull,
    PIP_NO_INDEX: '1',
    PIP_FIND_LINKS: wheelhouse,
    PIP_DISABLE_PIP_VERSION_CHECK: '1',
    PYTHONPATH: '',
  };
  const linkDir = path.join(home, 'links');
  const result = await installTool(pythonManifest(), { version: '1.0.0', links: linkDir }, {
    home,
    repoRoot,
    env,
    log: () => {},
  });
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
  const invoked = runCli(['--home', home, '--subprojects', subprojects, '-m', 'pyprobe', ...args], env);
  assert.equal(invoked.status, 0, invoked.stderr);
  assert.deepEqual(JSON.parse(invoked.stdout.trim()), args);
  const help = runCli(['--home', home, '--subprojects', subprojects, '-m', 'pyprobe', '--help'], env);
  assert.equal(help.status, 0, help.stderr);
  assert.equal(help.stdout.trim(), 'usage: pyprobe [arguments...]');
  const version = runCli(['--home', home, '--subprojects', subprojects, '-m', 'pyprobe', '--version'], env);
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), 'pyprobe 1.0.0');
});
