import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../src/cli.ts';
import { resolveHome } from '../src/config.ts';

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
  for (const line of ['install <tool>', 'run <tool> [args]', 'version', 'help [command]']) {
    assert.ok(help.text.includes(line), `help should document ${line}`);
  }
  assert.ok(!/^\s*list\b/m.test(help.text), 'help must not advertise a list command');
  assert.equal(runCli(['help', 'list']).status, 2);
});

test('parseArgs keeps the tool argv untouched from the tool id on', () => {
  const plain = parseArgs(['run', 'kuna', '--version']);
  assert.equal(plain.command, 'run');
  assert.deepEqual(plain.positionals, ['kuna']);
  assert.deepEqual(plain.runArgs, ['--version']);

  // decx options may sit between `run` and the tool id ...
  const withOptions = parseArgs(['run', '--home', '/tmp/decx-home', '--subprojects', '/tmp/decx-subprojects', '--pretty', 'kuna', 'docs', 'cli']);
  assert.deepEqual(withOptions.positionals, ['kuna']);
  assert.equal(withOptions.home, '/tmp/decx-home');
  assert.equal(withOptions.subprojects, '/tmp/decx-subprojects');
  assert.equal(withOptions.pretty, true);
  assert.deepEqual(withOptions.runArgs, ['docs', 'cli']);

  // ... but everything after the id belongs to the tool, even our own names.
  const forwarded = parseArgs(['run', '--home', '/tmp/decx-home', 'demo', '--flag']);
  assert.equal(forwarded.home, '/tmp/decx-home');
  assert.deepEqual(forwarded.runArgs, ['--flag']);
  assert.deepEqual(parseArgs(['run', 'kuna', '--home', '/tmp/elsewhere']).runArgs, ['--home', '/tmp/elsewhere']);
  assert.deepEqual(parseArgs(['run', 'kuna', '-h']).runArgs, ['-h']);

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
