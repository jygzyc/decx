import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { launchSpec, parseArgs } from '../src/cli.ts';
import { resolveHome } from '../src/config.ts';
import { envCmdLauncherText, envLauncherText } from '../src/install.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, '..', 'src', 'cli.ts');

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'decx-cli-'));
}

function runCli(args: string[], env: NodeJS.ProcessEnv = {}): { status: number | null; json: unknown; text: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  const text = (result.stdout ?? '').trim();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: result.status, json, text };
}

test('the manager installs, runs and reports its version -- and nothing else', () => {
  const { status, json } = runCli(['list'], { PATH: '' });
  assert.equal(status, 2);
  const payload = json as { ok: boolean; error: { code: string; hint?: string } };
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, 'UNKNOWN_COMMAND');
  assert.match(payload.error.hint ?? '', /decx help/);

  // Help advertises exactly the commands that still exist.
  const help = runCli(['help']);
  assert.equal(help.status, 0);
  for (const line of ['install <tool>', '-m, --module <tool>', 'version', 'help [command]']) {
    assert.ok(help.text.includes(line), `help should document ${line}`);
  }
  assert.ok(!help.text.includes('run <tool>'), 'help must not advertise the removed run command');
  assert.ok(!/^\s*list\b/m.test(help.text), 'help must not advertise a list command');
  assert.equal(runCli(['help', 'list']).status, 2);
});

test('the module flag is a usage error without a value or for an unknown tool', () => {
  // A module without a value, and an unknown tool, are both usage errors.
  const missing = runCli(['-m']);
  assert.equal(missing.status, 2);
  assert.equal((missing.json as { error: { code: string } }).error.code, 'USAGE');

  const unknown = runCli(['-m', 'nope']);
  assert.equal(unknown.status, 2);
  const payload = unknown.json as { command: string; error: { code: string } };
  assert.equal(payload.command, 'module');
  assert.equal(payload.error.code, 'UNKNOWN_TOOL');
});

test('parseArgs keeps the tool argv untouched from the module id on', () => {
  const plain = parseArgs(['-m', 'kuna', '--version']);
  assert.equal(plain.command, null);
  assert.equal(plain.module, 'kuna');
  assert.deepEqual(plain.toolArgs, ['--version']);

  // decx options may sit before the module, in either spelling ...
  const withOptions = parseArgs(['--home', '/tmp/decx-home', '--subprojects', '/tmp/decx-subprojects', '--pretty', '-m', 'kuna', 'docs', 'cli']);
  assert.equal(withOptions.home, '/tmp/decx-home');
  assert.equal(withOptions.subprojects, '/tmp/decx-subprojects');
  assert.equal(withOptions.pretty, true);
  assert.equal(withOptions.module, 'kuna');
  assert.deepEqual(withOptions.toolArgs, ['docs', 'cli']);
  assert.deepEqual(parseArgs(['--module', 'kuna', 'docs', 'cli']).toolArgs, ['docs', 'cli']);

  // ... but everything after the id belongs to the tool, even our own names.
  const forwarded = parseArgs(['--home', '/tmp/decx-home', '-m', 'demo', '--flag']);
  assert.equal(forwarded.home, '/tmp/decx-home');
  assert.deepEqual(forwarded.toolArgs, ['--flag']);
  assert.deepEqual(parseArgs(['-m', 'kuna', '--home', '/tmp/elsewhere']).toolArgs, ['--home', '/tmp/elsewhere']);
  assert.deepEqual(parseArgs(['-m', 'kuna', '-h']).toolArgs, ['-h']);
  const unusual = ['', 'two words', 'a"b', 'trailing\\', '--', '--pretty', '--module'];
  assert.deepEqual(parseArgs(['-m', 'kuna', ...unusual]).toolArgs, unusual);

  // The module flag needs a value and only belongs to a bare invocation.
  assert.equal(parseArgs(['-m']).error, 'missing value for -m');
  assert.equal(parseArgs(['--module']).error, 'missing value for --module');
  assert.equal(parseArgs(['install', '-m', 'kuna']).error, 'unknown option: -m');
  assert.equal(parseArgs(['install', 'demo', '--from-source']).error, 'unknown option: --from-source');
  assert.equal(parseArgs(['install', 'demo', '--source', '/tmp/checkout']).error, 'unknown option: --source');

  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs(['--version']).versionFlag, true);
  assert.equal(parseArgs(['--bogus', 'kuna']).error, 'unknown option: --bogus');
  assert.equal(parseArgs(['install', 'demo', '--home']).error, 'missing value for --home');
  // `--version` after `install` is the release tag, not the CLI version flag.
  assert.equal(parseArgs(['install', '--version', '1.0.0']).releaseTag, '1.0.0');
  assert.equal(parseArgs(['install', '--version', '1.0.0']).versionFlag, false);
});

test('the install root resolves from --home, --prefix or DECX_HOME', () => {
  const flagged = tempDir();
  const fromEnvDir = tempDir();
  const env = { DECX_HOME: fromEnvDir, PATH: '' };
  // An explicit flag wins over the environment, whether it is spelled --home
  // or --prefix; DECX_HOME is the fallback.
  assert.equal(resolveHome(parseArgs(['install', 'demo', '--home', flagged]).home, env), path.resolve(flagged));
  assert.equal(resolveHome(parseArgs(['install', 'demo', '--prefix', flagged]).home, env), path.resolve(flagged));
  assert.equal(resolveHome(undefined, env), path.resolve(fromEnvDir));
});

test('unknown commands fail with a usage envelope', () => {
  const { status, json } = runCli(['frobnicate']);
  assert.equal(status, 2);
  const payload = json as { ok: boolean; error: { code: string; hint?: string } };
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, 'UNKNOWN_COMMAND');
  assert.match(payload.error.hint ?? '', /decx help/);
});

test('a command without its tool id is a usage error', () => {
  const { status, json } = runCli(['install']);
  assert.equal(status, 2);
  const payload = json as { ok: boolean; error: { code: string; hint?: string } };
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, 'USAGE');
  assert.match(payload.error.hint ?? '', /decx help/);
});

test('missing option values are a usage error', () => {
  const { status, json } = runCli(['install', 'demo', '--home']);
  assert.equal(status, 2);
  assert.equal((json as { error: { code: string } }).error.code, 'USAGE');
});

test('version prints the package version and the running node', () => {
  const { status, json } = runCli(['version']);
  assert.equal(status, 0);
  const payload = json as { ok: boolean; command: string; version: string; node: string };
  assert.equal(payload.ok, true);
  assert.equal(payload.command, 'version');
  assert.match(payload.version, /^\d+\.\d+\.\d+$/);
  assert.equal(payload.node, process.versions.node);
});

test('help prints text, not JSON', () => {
  const { status, text } = runCli(['help']);
  assert.equal(status, 0);
  assert.match(text, /usage: decx <command> \[options\]/);
  assert.match(text, /install/);
});

test('--pretty indents the JSON output', () => {
  const { status, text } = runCli(['version', '--pretty']);
  assert.equal(status, 0);
  assert.match(text, /\n {2}"ok": true/);
});

test('launchSpec leaves native argv alone and marks pre-escaped cmd arguments verbatim', () => {
  const args = ['', 'two words', 'a"b', 'C:\\with space\\', '--home', '&|<>^'];
  for (const [platform, launcher] of [['linux', '/tmp/tool'], ['win32', 'C:\\tools\\tool.exe']] as const) {
    const spec = launchSpec(launcher, args, platform);
    assert.deepEqual(spec, { command: launcher, args });
    assert.notEqual(spec.args, args);
  }
  for (const extension of ['cmd', 'BAT']) {
    const spec = launchSpec(`C:\\tool dir\\demo.${extension}`, ['', 'a"b', 'end\\'], 'win32', { ComSpec: 'custom-cmd.exe' });
    assert.equal(spec.command, 'custom-cmd.exe');
    assert.equal(spec.windowsVerbatimArguments, true);
    assert.deepEqual(spec.args.slice(0, -1), ['/d', '/s', '/v:off', '/c']);
    assert.equal(spec.args.at(-1), `"C:\\tool^ dir\\demo.${extension} ^^^"^^^" ^^^"a\\^^^"b^^^" ^^^"end\\\\^^^""`);
  }
});

for (const kind of ['native', 'posix launcher', 'Windows cmd launcher'] as const) {
  test(`-m preserves argv, stdio, exit code and environment through a ${kind}`, {
    skip: kind === 'Windows cmd launcher' ? process.platform !== 'win32' : kind === 'posix launcher' && process.platform === 'win32',
  }, (t) => {
    const root = fs.realpathSync(tempDir());
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const home = path.join(root, 'install with spaces');
    const payload = path.join(home, 'share', 'demo');
    const subprojects = path.join(root, 'subprojects');
    fs.mkdirSync(path.join(home, 'bin'), { recursive: true });
    fs.mkdirSync(payload, { recursive: true });
    fs.mkdirSync(path.join(subprojects, 'decx-demo'), { recursive: true });
    fs.writeFileSync(path.join(subprojects, 'decx-demo', 'decx-demo.json'), JSON.stringify({
      manifest: 2, summary: 'offline argv probe', bins: ['demo'],
      release: { asset: 'demo-{version}-{os}-{arch}.zip' },
    }));
    const script = path.join(payload, 'probe.cjs');
    fs.writeFileSync(script, `
      const fs = require('node:fs');
      process.stdout.write(JSON.stringify({ args: process.argv.slice(2),
        input: fs.readFileSync(0, 'utf8'), home: process.env.DECX_HOME,
        inherited: process.env.DECX_TEST_INHERITED, initialized: process.env.DECX_TEST_INITIALIZED,
        path: process.env.PATH, cwd: process.cwd() }));
      process.stderr.write('native stderr\\n');
      process.exit(Number(process.env.DECX_TEST_EXIT));
    `);
    if (kind === 'native') {
      const target = path.join(home, 'bin', process.platform === 'win32' ? 'demo.exe' : 'demo');
      fs.copyFileSync(process.execPath, target);
      fs.chmodSync(target, 0o755);
    } else {
      const initialized = { DECX_TEST_INITIALIZED: payload };
      const windows = kind === 'Windows cmd launcher';
      fs.writeFileSync(path.join(home, 'bin', windows ? 'demo.cmd' : 'demo'),
        windows ? envCmdLauncherText(process.execPath, initialized) : envLauncherText(process.execPath, initialized),
        { mode: 0o755 });
    }
    const args = ['', 'two words', 'a"b', 'say "hello world"', 'C:\\space here\\', '\\"', '--home', '--pretty', '--', '中文'];
    for (const exit of [0, 37]) {
      const result = spawnSync(process.execPath, [CLI, '--home', home, '--subprojects', subprojects, '-m', 'demo', script, ...args], {
        encoding: 'utf8', input: 'stdin unchanged\n', cwd: root,
        env: { ...process.env, DECX_HOME: path.join(root, 'wrong home'), DECX_TEST_INHERITED: 'parent value',
          DECX_TEST_INITIALIZED: 'parent default', DECX_TEST_EXIT: String(exit) },
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, exit, result.stdout + result.stderr);
      assert.equal(result.stderr, 'native stderr\n');
      assert.deepEqual(JSON.parse(result.stdout), {
        args, input: 'stdin unchanged\n', home, inherited: 'parent value',
        initialized: kind === 'native' ? 'parent default' : payload,
        path: process.env.PATH, cwd: root,
      });
    }
  });
}
