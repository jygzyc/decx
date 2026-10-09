#!/usr/bin/env node
/** Pinned SDK setup and native compilation. Node is needed only on the build host. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractArchive } from '../src/archive.ts';
import { loadManifests } from '../src/manifest.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const executable = process.platform === 'win32' ? 'scriptc.exe' : 'scriptc';
const compiler = path.join(root, '.scriptc-toolchain/bin', executable);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', ...options });
  if (result.status !== 0) {
    throw Object.assign(new Error(`${command} ${args.join(' ')}: ${result.error ?? result.stderr}\n${result.stdout}`), {
      exitCode: result.status ?? 1,
    });
  }
  return result.stdout;
}

/** Verify before extraction; atomically replace the SDK only after version checks. */
export async function installSdk(root, {
  download = fetch,
  verify = compiler => spawnSync(compiler, ['--version'], { encoding: 'utf8', timeout: 30_000 }),
} = {}) {
  const pin = JSON.parse(fs.readFileSync(path.join(root, 'scriptc.json'), 'utf8'));
  let suffix = '';
  if (process.platform === 'linux') suffix = process.report.getReport().header.glibcVersionRuntime ? '-gnu' : '-musl';
  if (process.platform === 'win32') suffix = '-msvc';
  const platform = `${process.platform}-${process.arch}${suffix}`;
  const expected = pin.sha256[platform];
  assert.match(expected ?? '', /^[a-f0-9]{64}$/, `no pinned scriptc SDK for ${platform}`);
  const asset = `scriptc-${pin.version}-${platform}.tar.gz`;
  const url = `https://github.com/${pin.repository}/releases/download/v${pin.version}/${asset}`;
  const prefix = path.join(root, '.scriptc-toolchain');
  const temporary = fs.mkdtempSync(path.join(root, '.scriptc-native-setup-'));
  const backup = `${temporary}-previous`;
  try {
    const response = await download(url, { signal: AbortSignal.timeout(180_000) });
    if (!response.ok) throw new Error(`scriptc SDK download failed: HTTP ${response.status} (${url})`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const digest = createHash('sha256').update(bytes).digest('hex');
    assert.equal(digest, expected, `scriptc SDK integrity failure: ${asset}`);
    const archive = path.join(temporary, asset);
    fs.writeFileSync(archive, bytes);
    const staged = path.join(temporary, 'sdk');
    extractArchive(archive, staged);
    const stagedCompiler = path.join(staged, 'bin', executable);
    const metadata = JSON.parse(fs.readFileSync(`${stagedCompiler}.json`, 'utf8'));
    assert.equal(metadata.schema, 'scriptc.native-toolchain.v1');
    assert.equal(metadata.compiler_version, pin.version);
    const result = verify(stagedCompiler);
    assert.equal(result.status, 0, `scriptc verification failed: ${result.error ?? result.stderr}`);
    assert.equal(result.stdout.trim(), pin.version);
    fs.writeFileSync(path.join(staged, 'SOURCE.json'), JSON.stringify({ version: pin.version, url, sha256: digest }, null, 2) + '\n');
    if (fs.existsSync(prefix)) fs.renameSync(prefix, backup);
    try {
      fs.renameSync(staged, prefix);
    } catch (error) {
      if (fs.existsSync(backup)) fs.renameSync(backup, prefix);
      throw error;
    }
    fs.rmSync(backup, { recursive: true, force: true });
    console.log(`installed scriptc ${pin.version} (${platform}, SHA-256 verified)`);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function windowsResource(directory) {
  const manifest = path.join(root, 'src/native/windows.manifest').replaceAll('\\', '/');
  const source = path.join(directory, 'windows.rc');
  const resource = path.join(directory, 'windows.res');
  fs.writeFileSync(source, `1 24 "${manifest}"\n`);
  run('zig', ['rc', '/c65001', '/fo', resource, source]);
  return resource;
}

function buildManager() {
  const supported = new Set(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'windows-x64']);
  const platform = `${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`;
  if (!supported.has(platform)) throw new Error(`scriptc does not support ${platform}`);
  if (process.env.SCRIPTC_TARGET || process.env.SCRIPTC_CC) {
    throw new Error('build:scriptc labels host binaries only; unset SCRIPTC_TARGET and SCRIPTC_CC');
  }
  const packageInfo = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const compilerVersion = JSON.parse(fs.readFileSync(path.join(root, 'scriptc.json'), 'utf8')).version;
  assert.equal(run(compiler, ['--version']).trim(), compilerVersion, 'run setup:scriptc to install the pinned compiler');
  const manifests = loadManifests(path.resolve(root, '..', 'subprojects'));
  assert.equal(manifests.issues.length, 0, 'native metadata must contain valid manifests');
  assert.ok(manifests.tools.length > 0, 'native metadata must contain tools');
  // Stage under the package for @types/node resolution. Shared application modules are unchanged.
  const temporary = fs.mkdtempSync(path.join(root, '.scriptc-native-'));
  try {
    const sources = path.join(temporary, 'src');
    fs.cpSync(path.join(root, 'src'), sources, { recursive: true });
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
      const ffi = path.join(temporary, 'ffi.json');
      fs.writeFileSync(ffi, JSON.stringify({
        ffi_format: 1,
        functions: [{ name: 'decxWindowsRun', symbol: 'decx_windows_run',
          params: ['string', 'string', 'string', 'string', 'string', 'i32', 'i32'], returns: 'f64' }],
        libraries: [object, windowsResource(temporary)], system_libraries: ['kernel32'],
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
}

function buildTool(args) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'decx-ts-tool-'));
  try {
    if (process.platform === 'win32' && (!process.env.SCRIPTC_TARGET || process.env.SCRIPTC_TARGET.includes('windows'))) {
      const index = args.indexOf('--ffi');
      let manifest = { ffi_format: 1, functions: [], libraries: [], system_libraries: [] };
      if (index !== -1) {
        const original = path.resolve(args[index + 1]);
        manifest = JSON.parse(fs.readFileSync(original, 'utf8'));
        manifest.libraries = (manifest.libraries ?? []).map(library => path.resolve(path.dirname(original), library));
        args.splice(index, 2);
      }
      manifest.libraries.push(windowsResource(temporary));
      const ffi = path.join(temporary, 'ffi.json');
      fs.writeFileSync(ffi, JSON.stringify(manifest));
      args.push('--ffi', ffi);
    }
    run(compiler, ['build', ...args], { cwd: process.cwd(), stdio: 'inherit' });
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, ...args] = process.argv.slice(2);
    if (command === 'setup') await installSdk(root);
    else if (command === 'build' || command === 'tool') {
      if (!fs.existsSync(compiler)) throw new Error('scriptc is not installed; run npm run setup:scriptc first');
      if (command === 'build') buildManager();
      else buildTool(args);
    } else throw new Error('usage: node scripts/scriptc.mjs <setup|build|tool> [compiler arguments]');
  } catch (error) {
    console.error(error.message);
    process.exitCode = error.exitCode ?? 1;
  }
}
