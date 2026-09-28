/**
 * PATH link tests: symlinks on POSIX, generated `.cmd` shims on Windows, and
 * the guarantee that a foreign file in the link directory is never overwritten
 * unless `--force` asks for it.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { launchSpec } from '../src/cli.ts';
import { binPath, provenanceFile } from '../src/config.ts';
import { envCmdLauncherText, venvLauncherText } from '../src/install.ts';
import { createLinks, linkFileName, linkName, removeManagedLink, shimText } from '../src/links.ts';

function tempDir(prefix = 'decx-links-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function store(home: string, ...names: string[]): void {
  fs.mkdirSync(path.dirname(binPath(home, names[0] as string)), { recursive: true });
  for (const name of names) {
    fs.writeFileSync(binPath(home, name), '#!/bin/sh\n', { mode: 0o755 });
  }
}

test('linkName strips the executable suffixes a store file may carry', () => {
  assert.equal(linkName('kuna'), 'kuna');
  assert.equal(linkName('kuna.exe'), 'kuna');
  assert.equal(linkName('droidasc.cmd'), 'droidasc');
  assert.equal(linkName('ASC.CMD'), 'ASC');
});

test('linkFileName adds .cmd on Windows only', () => {
  assert.equal(linkFileName('kuna', false), 'kuna');
  assert.equal(linkFileName('kuna', true), 'kuna.cmd');
  assert.equal(linkFileName('kuna.exe', true), 'kuna.exe');
});

test('createLinks links every managed executable into the link directory', () => {
  const home = tempDir();
  const linkDir = tempDir();
  store(home, 'kuna', 'decomp_dbg', 'slacomp');
  const outcomes = createLinks({ home, files: ['kuna', 'decomp_dbg', 'slacomp'], linkDir });
  assert.deepEqual(outcomes.map((outcome) => outcome.status), ['created', 'created', 'created']);
  let created = 0;
  for (const entry of fs.readdirSync(linkDir)) {
    created += 1;
    if (process.platform !== 'win32') {
      assert.ok(fs.lstatSync(path.join(linkDir, entry)).isSymbolicLink());
      assert.equal(fs.realpathSync(path.join(linkDir, entry)), fs.realpathSync(binPath(home, entry)));
    }
  }
  assert.equal(created, 3);
});

test('prefers the platform launcher when two staged files share one command', () => {
  const home = tempDir();
  store(home, 'droidasc', 'droidasc.cmd');
  const windowsDir = tempDir();
  createLinks({ home, files: ['droidasc', 'droidasc.cmd'], linkDir: windowsDir, windows: true });
  assert.deepEqual(fs.readdirSync(windowsDir), ['droidasc.cmd']);
  assert.equal(fs.readFileSync(path.join(windowsDir, 'droidasc.cmd'), 'utf8'), shimText(binPath(home, 'droidasc.cmd')));
  if (process.platform !== 'win32') {
    const posixDir = tempDir();
    createLinks({ home, files: ['droidasc.cmd', 'droidasc'], linkDir: posixDir, windows: false });
    assert.deepEqual(fs.readdirSync(posixDir), ['droidasc']);
    assert.equal(fs.realpathSync(path.join(posixDir, 'droidasc')), fs.realpathSync(binPath(home, 'droidasc')));
  }
});

test('stale Windows shims are removed only when they still point to the recorded target', () => {
  const home = tempDir();
  const linkDir = tempDir();
  store(home, 'demo.exe');
  createLinks({ home, files: ['demo.exe'], linkDir, windows: true });
  const link = path.join(linkDir, 'demo.cmd');
  assert.equal(removeManagedLink(linkDir, 'demo.exe', binPath(home, 'other.exe'), true), false);
  assert.ok(fs.existsSync(link));
  assert.equal(removeManagedLink(linkDir, 'demo.exe', binPath(home, 'demo.exe'), true), true);
  assert.equal(fs.existsSync(link), false);
});

test('createLinks is idempotent', () => {
  const home = tempDir();
  const linkDir = tempDir();
  store(home, 'kuna');
  createLinks({ home, files: ['kuna'], linkDir });
  const again = createLinks({ home, files: ['kuna'], linkDir });
  assert.equal(again[0]?.status, 'unchanged');
});

test('createLinks never replaces a foreign file without force', () => {
  const home = tempDir();
  const linkDir = tempDir();
  store(home, 'kuna');
  const foreign = path.join(linkDir, linkFileName('kuna'));
  fs.writeFileSync(foreign, '#!/bin/sh\necho someone else\n', { mode: 0o755 });
  const outcomes = createLinks({ home, files: ['kuna'], linkDir });
  assert.equal(outcomes[0]?.status, 'conflict');
  assert.match(outcomes[0]?.reason ?? '', /not created by decx/);
  assert.equal(fs.readFileSync(foreign, 'utf8'), '#!/bin/sh\necho someone else\n');
  assert.equal(fs.lstatSync(foreign).isSymbolicLink(), false, 'the foreign file is not replaced by a link');
  // The conflict is reported, not fatal: the store keeps the managed executable.
  assert.ok(fs.existsSync(binPath(home, 'kuna')));
});

test('createLinks with force moves the foreign file aside', () => {
  const home = tempDir();
  const linkDir = tempDir();
  store(home, 'kuna');
  const foreign = path.join(linkDir, linkFileName('kuna'));
  fs.writeFileSync(foreign, '#!/bin/sh\necho someone else\n', { mode: 0o755 });
  const outcomes = createLinks({ home, files: ['kuna'], linkDir, force: true });
  assert.equal(outcomes[0]?.status, 'updated');
  const leftovers = fs.readdirSync(linkDir).filter((entry) => entry.startsWith(`${linkFileName('kuna')}.decx-old-`));
  assert.equal(leftovers.length, 1);
  const link = path.join(linkDir, linkFileName('kuna'));
  if (process.platform === 'win32') {
    assert.match(fs.readFileSync(link, 'utf8'), /Generated by decx install/);
  } else {
    assert.equal(fs.realpathSync(link), fs.realpathSync(binPath(home, 'kuna')));
  }
});

test('managed Windows shims refresh when the launcher target or body changes', (t) => {
  const root = tempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const linkDir = path.join(root, 'links');
  store(home, 'demo.exe', 'demo.cmd');
  const options = { home, linkDir, windows: true };
  assert.equal(createLinks({ ...options, files: ['demo.exe'] })[0]?.status, 'created');
  const link = path.join(linkDir, 'demo.cmd');
  assert.equal(createLinks({ ...options, files: ['demo.cmd'] })[0]?.status, 'updated');
  assert.equal(fs.readFileSync(link, 'utf8'), shimText(binPath(home, 'demo.cmd')));
  assert.equal(createLinks({ ...options, files: ['demo.cmd'] })[0]?.status, 'unchanged');
  fs.writeFileSync(link, shimText(binPath(home, 'demo.cmd')).replace('exit /b %errorlevel%', 'rem outdated body'));
  assert.equal(createLinks({ ...options, files: ['demo.cmd'] })[0]?.status, 'updated');
  assert.equal(fs.readFileSync(link, 'utf8'), shimText(binPath(home, 'demo.cmd')));
  const nextHome = path.join(root, 'new home');
  store(nextHome, 'demo.cmd');
  assert.equal(createLinks({ ...options, home: nextHome, files: ['demo.cmd'] })[0]?.status, 'updated');
  assert.equal(fs.readFileSync(link, 'utf8'), shimText(binPath(nextHome, 'demo.cmd')));
  assert.deepEqual(fs.readdirSync(linkDir), ['demo.cmd']);
});

test('managed POSIX links refresh changed and dangling targets, but foreign links stay intact', {
  skip: process.platform === 'win32',
}, (t) => {
  const root = tempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const linkDir = path.join(root, 'links');
  store(home, 'demo', 'demo.exe');
  const options = { home, linkDir, windows: false };
  createLinks({ ...options, files: ['demo.exe'] });
  const link = path.join(linkDir, 'demo');
  fs.unlinkSync(binPath(home, 'demo.exe'));
  assert.equal(createLinks({ ...options, files: ['demo'] })[0]?.status, 'updated');
  assert.equal(fs.readlinkSync(link), binPath(home, 'demo'));
  assert.equal(createLinks({ ...options, files: ['demo'] })[0]?.status, 'unchanged');
  store(home, 'demo.exe');
  assert.equal(createLinks({ ...options, files: ['demo.exe'] })[0]?.status, 'updated');
  assert.equal(fs.readlinkSync(link), binPath(home, 'demo.exe'));
  assert.equal(fs.readFileSync(binPath(home, 'demo'), 'utf8'), '#!/bin/sh\n');
  fs.unlinkSync(link);
  const foreign = path.join(root, 'other', 'demo');
  fs.symlinkSync(foreign, link);
  assert.equal(createLinks({ ...options, files: ['demo'] })[0]?.status, 'conflict');
  assert.equal(fs.readlinkSync(link), foreign);
});

test('Windows PATH shim reaches the refreshed launcher and initializes its environment', {
  skip: process.platform !== 'win32',
}, (t) => {
  const root = tempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home with spaces');
  const linkDir = path.join(root, 'PATH links');
  store(home, 'demo.exe');
  createLinks({ home, linkDir, files: ['demo.exe'] });
  fs.unlinkSync(binPath(home, 'demo.exe'));
  fs.writeFileSync(binPath(home, 'demo.cmd'), envCmdLauncherText(process.execPath, { DECX_TEST_INITIALIZED: 'ready' }));
  assert.equal(createLinks({ home, linkDir, files: ['demo.cmd'] })[0]?.status, 'updated');
  const script = path.join(root, 'probe.cjs');
  fs.writeFileSync(script, `process.stdout.write(JSON.stringify({ args: process.argv.slice(2), env: process.env.DECX_TEST_INITIALIZED })); process.exit(29);`);
  const args = ['', 'two words', 'trailing\\'];
  const spec = launchSpec(path.join(linkDir, 'demo.cmd'), [script, ...args]);
  const result = spawnSync(spec.command, spec.args, { encoding: 'utf8', windowsVerbatimArguments: spec.windowsVerbatimArguments });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 29, result.stdout + result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { args, env: 'ready' });
});

test('shimText carries the marker and forwards argv', () => {
  const text = shimText('C:\\Users\\me\\.decx\\bin\\kuna.exe');
  assert.match(text, /Generated by decx install/);
  assert.match(text, /"C:\\Users\\me\\\.decx\\bin\\kuna\.exe" %\*/);
  assert.match(text, /exit \/b %errorlevel%/);
  assert.ok(text.includes('\r\n'));
});

test('the store file and the PROVENANCE file are the only state', () => {
  // Guards the layout contract other modules rely on.
  const home = tempDir();
  store(home, 'kuna');
  assert.ok(fs.existsSync(binPath(home, 'kuna')));
  assert.match(provenanceFile(home, 'kuna'), /share[\\/]kuna[\\/]PROVENANCE$/);
});

test('a script launcher runs correctly through its PATH symlink', { skip: process.platform === 'win32' }, () => {
  // Regression: the launcher used to derive its root from $0, so executing it
  // through ~/.local/bin/<name> resolved the payload against the link's parent.
  const home = tempDir('decx-home-');
  const linkDir = tempDir('decx-links-');
  fs.mkdirSync(path.dirname(binPath(home, 'droidasc')), { recursive: true });
  fs.writeFileSync(
    binPath(home, 'droidasc'),
    venvLauncherText({ id: 'droidasc', platformOs: 'linux', venvBin: 'bin', command: 'droidasc' }),
    { mode: 0o755 },
  );
  fs.mkdirSync(path.join(home, 'runtime', 'droidasc', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(home, 'runtime', 'droidasc', 'bin', 'droidasc'), '#!/bin/sh\necho "venv:$*"\n', {
    mode: 0o755,
  });
  createLinks({ home, files: ['droidasc'], linkDir });
  const run = spawnSync(path.join(linkDir, 'droidasc'), ['getmanifest', 'app.apk'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), `venv:getmanifest app.apk`);

  // The same launcher still works when called directly from the store.
  const direct = spawnSync(binPath(home, 'droidasc'), ['getclass', 'app.apk', 'com.poc.Main'], { encoding: 'utf8' });
  assert.equal(direct.status, 0, direct.stderr);
  assert.equal(direct.stdout.trim(), `venv:getclass app.apk com.poc.Main`);
});
