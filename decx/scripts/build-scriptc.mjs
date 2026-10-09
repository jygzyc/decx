#!/usr/bin/env node
/** Compile the typed manager with explicit native adapters; never rewrite application code. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifests } from '../src/manifest.ts';
import { windowsResource } from './windows-resource.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const supported = new Set(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'windows-x64']);
const platform = `${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`;
if (!supported.has(platform)) throw new Error(`scriptc does not support ${platform}`);
if (process.env.SCRIPTC_TARGET || process.env.SCRIPTC_CC) {
  throw new Error('build:scriptc labels host binaries only; unset SCRIPTC_TARGET and SCRIPTC_CC');
}
const compiler = path.join(root, '.scriptc-toolchain/node_modules/scriptc/bin/scriptc.exe');
if (!fs.existsSync(compiler)) throw new Error('scriptc is not installed; run npm run setup:scriptc first');
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', ...options });
  assert.equal(result.status, 0, `${command} ${args.join(' ')}: ${result.error ?? result.stderr}\n${result.stdout}`);
  return result.stdout;
};
const packageInfo = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const compilerVersion = JSON.parse(fs.readFileSync(path.join(root, 'toolchains/scriptc/package.json'), 'utf8')).dependencies.scriptc;
assert.equal(run(compiler, ['--version']).trim(), compilerVersion, 'run setup:scriptc to install the pinned compiler');
const manifests = loadManifests(path.resolve(root, '..', 'subprojects'));
assert.equal(manifests.issues.length, 0, 'native metadata must contain valid manifests');
assert.ok(manifests.tools.length > 0, 'native metadata must contain tools');
// Stage under the package to resolve @types/node. Application modules remain unchanged;
// only runtime adapters and generated build metadata select the native target.
const temporary = fs.mkdtempSync(path.join(root, '.scriptc-native-'));
try {
  const sources = path.join(temporary, 'src');
  fs.cpSync(path.join(root, 'src'), sources, { recursive: true });
  fs.writeFileSync(path.join(sources, 'transport.ts'), "export { openResponse } from './native/transport.ts';\n");
  const runner = process.platform === 'win32' ? 'runner-windows' : 'runner';
  fs.writeFileSync(path.join(sources, 'runner.ts'), `export { defaultRunner } from './native/${runner}.ts';\n`);
  fs.writeFileSync(path.join(sources, 'build-info.ts'), [
    "import type { LoadResult } from './manifest.ts';",
    `export const embeddedManifests: LoadResult | undefined = ${JSON.stringify(manifests)};`,
    `export const runtimeInfo = { runtime: 'scriptc', compiler: ${JSON.stringify(compilerVersion)} };`,
    `export function packageVersion(): string { return ${JSON.stringify(packageInfo.version)}; }`,
  ].join('\n'));
  const source = path.join(temporary, 'native-cli.ts');
  fs.writeFileSync(source, "import { runEntry } from './src/cli.ts';\nrunEntry();\n");
  const ffiArgs = [];
  if (process.platform === 'win32') {
    const object = path.join(temporary, 'windows-process.obj');
    run('zig', ['cc', '-target', 'x86_64-windows-gnu', '-c', path.join(root, 'src/native/windows-process.c'), '-o', object, '-O2', '-Wall', '-Wextra', '-Werror']);
    const resource = windowsResource(temporary, run);
    const ffi = path.join(temporary, 'ffi.json');
    fs.writeFileSync(ffi, JSON.stringify({
      ffi_format: 1,
      functions: [{ name: 'decxWindowsRun', symbol: 'decx_windows_run',
        params: ['string', 'string', 'string', 'string', 'string', 'i32', 'i32'], returns: 'f64' }],
      libraries: [object, resource], system_libraries: ['kernel32'],
    }));
    ffiArgs.push('--ffi', ffi);
  }
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  const name = `decx-${platform}${process.platform === 'win32' ? '.exe' : ''}`;
  const destination = path.join(root, 'dist', name);
  const binary = path.join(temporary, name);
  fs.rmSync(destination, { force: true });
  run(compiler, ['build', source, '-o', binary, '--no-keep-llvm', '--dynamic', ...ffiArgs], { timeout: 180_000 });
  const smokeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'decx-native-smoke-'));
  try {
    const options = { cwd: smokeHome, timeout: 30_000, env: {
      ...process.env, PATH: smokeHome, Path: smokeHome, HOME: smokeHome,
      USERPROFILE: smokeHome, DECX_HOME: path.join(smokeHome, 'home'),
    } };
    const version = JSON.parse(run(binary, ['version'], options));
    assert.equal(version.ok, true);
    assert.equal(version.version, packageInfo.version);
    assert.match(run(binary, ['help'], options), /usage: decx/);
  } finally {
    fs.rmSync(smokeHome, { recursive: true, force: true });
  }
  fs.renameSync(binary, destination);
  console.log(`built ${path.relative(root, destination)} with scriptc`);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
