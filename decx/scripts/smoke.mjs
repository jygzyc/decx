#!/usr/bin/env node
/**
 * Smoke the CLI from a working directory that is not the repository:
 * `version` must print one JSON envelope carrying the package version,
 * `help` must exit 0, and an unknown command must exit 2 with the failure
 * envelope. `--source` smokes `src/cli.ts` instead of the built `dist/` CLI.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { distRoot, packageInfo, packageRoot } from './common.mjs';

const cli = process.argv.includes('--source')
  ? path.join(packageRoot, 'src', 'cli.ts')
  : path.join(distRoot, 'decx', 'lib', 'cli.js');
if (!fs.existsSync(cli)) {
  throw new Error(`${cli} does not exist; run \`npm run build\` first`);
}

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'decx-smoke-'));
const run = (args) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });

const fail = (message) => {
  console.error(`smoke failed: ${message}`);
  process.exit(1);
};

const version = run(['version']);
if (version.status !== 0) {
  fail(`\`version\` exited ${version.status}: ${version.stderr}`);
}
let envelope;
try {
  envelope = JSON.parse(version.stdout);
} catch {
  fail(`\`version\` did not print a JSON envelope: ${version.stdout}`);
}
const expected = packageInfo().version;
if (envelope.ok !== true || envelope.version !== expected) {
  fail(`\`version\` printed ${JSON.stringify(envelope)}, expected version ${expected}`);
}

const help = run(['help']);
if (help.status !== 0) {
  fail(`\`help\` exited ${help.status}: ${help.stderr}`);
}

const unknown = run(['nope']);
if (unknown.status !== 2) {
  fail(`an unknown command exited ${unknown.status}, expected 2`);
}
try {
  if (JSON.parse(unknown.stdout).ok !== false) {
    fail('the unknown-command envelope is not a failure envelope');
  }
} catch {
  fail(`the unknown command did not print a JSON envelope: ${unknown.stdout}`);
}

console.log(`smoke ok: decx ${expected} (${cli})`);
