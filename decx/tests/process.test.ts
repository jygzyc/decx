import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { defaultRunner, runCommand } from '../src/bridge/process.ts';

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
  const result = await runCommand({ env }, process.execPath, ['-e',
    `process.stdout.write(JSON.stringify({args:process.argv.slice(1),keep:process.env.DECX_KEEP,extra:process.env.DECX_EXTRA})+'\\n\\n');process.stderr.write('stderr\\n');process.exitCode=7`,
    '--', ...args], 'capture', { DECX_EXTRA: 'extra' });
  assert.equal(result.status, 7);
  assert.equal(result.error, undefined);
  assert.ok(result.stdout.endsWith('\n\n'));
  assert.deepEqual(JSON.parse(result.stdout), { args, keep: 'kept', extra: 'extra' });
  assert.equal(result.stderr, 'stderr\n');
  const isolated = await defaultRunner({ command: process.execPath,
    args: ['-p', 'JSON.stringify(process.env.PATH)'], env: {} });
  assert.equal(isolated.status, 0);
  assert.equal(isolated.stdout, 'undefined\n');
});

test('spawn failure and signal termination remain distinct from nonzero exits', async t => {
  const root = temporaryRoot(t);
  const missing = await defaultRunner({ command: path.join(root, 'nonexistent-command'), args: [] });
  assert.equal(missing.status, null);
  assert.match(missing.error!, /ENOENT/);
  assert.equal(missing.stdout, '');
  assert.equal(missing.stderr, '');
  if (process.platform !== 'win32') {
    const signaled = await defaultRunner({ command: process.execPath,
      args: ['-e', "process.kill(process.pid, 'SIGTERM')"] });
    assert.equal(signaled.status, null);
    assert.equal(signaled.error, undefined);
  }
});

test('stream logs stay on stderr while inherit preserves tool output and exit code', () => {
  const probe = "process.stdout.write('out\\n');process.stderr.write('err\\n');process.exitCode=7";
  for (const mode of ['stream', 'inherit'] as const) {
    const source = `import assert from 'node:assert/strict';
      import {defaultRunner} from ${JSON.stringify(bridgeUrl)};
      const result=await defaultRunner({command:process.execPath,args:['-e',${JSON.stringify(probe)}],mode:${JSON.stringify(mode)}});
      assert.equal(result.status,7);
      if (${JSON.stringify(mode)}==='stream') console.log(JSON.stringify(result));
      else {assert.equal(result.stdout,'');assert.equal(result.stderr,'');process.exitCode=result.status;}`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8' });
    assert.equal(result.status, mode === 'stream' ? 0 : 7, result.stderr);
    if (mode === 'stream') {
      assert.deepEqual(JSON.parse(result.stdout), { status: 7, stdout: 'out\n', stderr: 'err\n' });
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
  fs.writeFileSync(command, `@echo off\r\nsetlocal DisableDelayedExpansion\r\n"${process.execPath}" "${script}" %*\r\n`);
  const args = ['a b', '中文', '&|<>^%!', '"quoted"', 'trailing\\'];
  const result = await defaultRunner({ command, args });
  assert.equal(result.status, 0, result.error ?? result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), args);
});
