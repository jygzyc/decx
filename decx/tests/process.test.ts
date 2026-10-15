import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { runCommand } from '../src/bridge/process.ts';

const bridgeUrl = new URL('../src/bridge/process.ts', import.meta.url).href;
const githubUrl = new URL('../src/download/github.ts', import.meta.url).href;

function temporaryRoot(t: test.TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'decx-process-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('process capture preserves argv, Unicode, newlines, exact env and nonzero exits', async () => {
  const args = ['a b', '中文', '&|<>^%!', '"quoted"', 'trailing\\', 'line\nbreak'];
  const env = { ...process.env, DECX_KEEP: 'kept' };
  const result = await runCommand(process.execPath, ['-e',
    `process.stdout.write(JSON.stringify({args:process.argv.slice(1),keep:process.env.DECX_KEEP,extra:process.env.DECX_EXTRA})+'\\n\\n');process.stderr.write('stderr\\n');process.exitCode=7`,
    '--', ...args], { env: { ...env, DECX_EXTRA: 'extra' } });
  assert.equal(result.exitCode, 7);
  assert.equal(result.failed, true);
  assert.ok(result.stdout?.endsWith('\n\n'));
  assert.deepEqual(JSON.parse(result.stdout ?? ''), { args, keep: 'kept', extra: 'extra' });
  assert.equal(result.stderr, 'stderr\n');
  const isolated = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import {runCommand} from ${JSON.stringify(bridgeUrl)};
    const {exitCode,stdout,stderr}=await runCommand(process.execPath,['-p','JSON.stringify(process.env.DECX_PARENT_ONLY)'],{env:{}});
    console.log(JSON.stringify({exitCode,stdout,stderr}));`], {
    env: { ...process.env, DECX_PARENT_ONLY: 'private' }, encoding: 'utf8',
  });
  assert.equal(isolated.status, 0, isolated.stderr);
  assert.deepEqual(JSON.parse(isolated.stdout), { exitCode: 0, stdout: 'undefined\n', stderr: '' });
});

test('missing commands and signal termination report platform-native failures', async t => {
  const root = temporaryRoot(t);
  const missing = await runCommand(path.join(root, 'nonexistent-command'), []);
  assert.equal(missing.stdout, '');
  if (process.platform === 'win32') {
    // Execa resolves non-native Windows commands through cmd.exe, whose missing
    // command diagnostic is a normal nonzero exit, not a Node spawn error.
    assert.equal(missing.exitCode, 1);
    assert.match(missing.stderr ?? '', /nonexistent-command/);
  } else {
    assert.equal(missing.exitCode, undefined);
    assert.match(missing.shortMessage ?? '', /ENOENT/);
    assert.equal(missing.stderr, '');
  }
  if (process.platform !== 'win32') {
    const signaled = await runCommand(process.execPath, ['-e', "process.kill(process.pid, 'SIGTERM')"]);
    assert.equal(signaled.exitCode, undefined);
    assert.equal(signaled.signal, 'SIGTERM');
  }
});

test('stream logs stay on stderr while inherit preserves tool output and exit code', () => {
  const probe = "process.stdout.write('out\\n');process.stderr.write('err\\n');process.exitCode=7";
  for (const mode of ['stream', 'inherit'] as const) {
    const source = `import assert from 'node:assert/strict';
      import {runCommand} from ${JSON.stringify(bridgeUrl)};
      const {exitCode,stdout,stderr}=await runCommand(process.execPath,['-e',${JSON.stringify(probe)}],{mode:${JSON.stringify(mode)}});
      assert.equal(exitCode,7);
      if (${JSON.stringify(mode)}==='stream') console.log(JSON.stringify({exitCode,stdout,stderr}));
      else {assert.equal(stdout,undefined);assert.equal(stderr,undefined);process.exitCode=exitCode;}`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8' });
    assert.equal(result.status, mode === 'stream' ? 0 : 7, result.stderr);
    if (mode === 'stream') {
      assert.deepEqual(JSON.parse(result.stdout), { exitCode: 7, stdout: 'out\n', stderr: 'err\n' });
      assert.match(result.stderr, /out\n/);
      assert.match(result.stderr, /err\n/);
    } else {
      assert.equal(result.stdout, 'out\n');
      assert.equal(result.stderr, 'err\n');
    }
  }
});

test('gh token probe uses execaSync without leaking output or accepting failed probes', t => {
  const root = temporaryRoot(t);
  const script = path.join(root, 'gh.cjs');
  fs.writeFileSync(script, `require('node:assert/strict').deepEqual(process.argv.slice(2),['auth','token']);process.stdout.write('  fixture-token\\n');process.stderr.write('private diagnostic\\n');process.exitCode=Number(process.env.DECX_GH_STATUS);`);
  const gh = path.join(root, process.platform === 'win32' ? 'gh.cmd' : 'gh');
  fs.writeFileSync(gh, process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
    : `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${script}' "$@"\n`, { mode: 0o755 });
  const source = `import {githubToken} from ${JSON.stringify(githubUrl)};console.log(JSON.stringify(githubToken()??null));`;
  for (const status of ['0', '1']) {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: root, USERPROFILE: root,
      GITHUB_TOKEN: '', GH_TOKEN: '', DECX_GH_STATUS: status };
    for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
    env.PATH = root;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout), status === '0' ? 'fixture-token' : null);
    assert.equal(result.stderr, '');
  }
});

test('Windows batch commands with spaced paths are executed by execa directly', { skip: process.platform !== 'win32' }, async t => {
  const root = temporaryRoot(t);
  const dir = path.join(root, '目录 with spaces');
  fs.mkdirSync(dir);
  const script = path.join(dir, 'probe.cjs');
  const command = path.join(dir, 'probe.cmd');
  fs.writeFileSync(script, 'console.log(JSON.stringify(process.argv.slice(2)));');
  // Keep batch source ASCII: cmd.exe reads its literals in the active code page;
  // %~dp0 expands the Unicode directory without re-decoding UTF-8 file contents.
  fs.writeFileSync(command, `@echo off\r\nsetlocal DisableDelayedExpansion\r\n"${process.execPath}" "%~dp0probe.cjs" %*\r\n`);
  const args = ['a b', '中文', '&|<>^%!', '"quoted"', 'trailing\\'];
  const result = await runCommand(command, args);
  assert.equal(result.exitCode, 0, result.shortMessage ?? result.stderr);
  assert.deepEqual(JSON.parse(result.stdout ?? ''), args);
});
