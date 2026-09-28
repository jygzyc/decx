#!/usr/bin/env node
/** Build a Node-dependent native launcher using scriptc. The Node CLI is embedded. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const supported = new Set(['darwin-arm64', 'linux-arm64', 'linux-x64', 'windows-x64']);
const platform = `${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`;
if (!supported.has(platform)) throw new Error(`scriptc does not support ${platform}`);
if (process.env.SCRIPTC_TARGET || process.env.SCRIPTC_CC) {
  throw new Error('build:scriptc labels host binaries only; unset SCRIPTC_TARGET and SCRIPTC_CC');
}

const compiler = path.join(root, '.scriptc-toolchain', 'node_modules', 'scriptc', 'dist', 'bootstrap.js');
if (!fs.existsSync(compiler)) throw new Error('scriptc is not installed; run npm run setup:scriptc first');

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', ...options });
  assert.equal(result.status, 0, `${command} ${args.join(' ')}: ${result.error ?? result.stderr}\n${result.stdout}`);
  return result.stdout;
};

// Build first so the embedded bundle and version are always from this checkout.
run(process.execPath, [path.join(root, 'scripts', 'build.mjs')]);
const bundle = fs.readFileSync(path.join(root, 'dist', 'decx.mjs'), 'utf8');
const template = fs.readFileSync(path.join(root, 'scripts', 'native-launcher.ts'), 'utf8');
const marker = "'__DECX_BUNDLE__'";
assert.equal(template.split(marker).length, 2, 'native launcher must contain one bundle marker');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'decx-scriptc-build-'));
try {
  const source = path.join(temporary, 'native-launcher.ts');
  fs.writeFileSync(source, template.replace(marker, JSON.stringify(bundle)));
  const binary = path.join(root, 'dist', `decx-${platform}${process.platform === 'win32' ? '.exe' : ''}`);
  run(process.execPath, [compiler, 'build', source, '-o', binary, '--no-keep-c'], { timeout: 180_000 });
  const version = JSON.parse(run(binary, ['version'], { timeout: 30_000 }));
  assert.equal(version.ok, true);
  assert.match(run(binary, ['help'], { timeout: 30_000 }), /usage: decx/);
  console.log(`built ${path.relative(root, binary)} with scriptc (Node required at runtime)`);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
