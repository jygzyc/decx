#!/usr/bin/env node
/** Compile typed manager sources using scriptc. Unsupported APIs fail the build. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifests } from '../src/manifest.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const supported = new Set(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'windows-x64']);
const platform = `${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`;
if (!supported.has(platform)) throw new Error(`scriptc does not support ${platform}`);
if (process.env.SCRIPTC_TARGET || process.env.SCRIPTC_CC) {
  throw new Error('build:scriptc labels host binaries only; unset SCRIPTC_TARGET and SCRIPTC_CC');
}

const compiler = path.join(root, '.scriptc-toolchain', 'node_modules', 'scriptc', 'bin', 'scriptc.exe');
if (!fs.existsSync(compiler)) throw new Error('scriptc is not installed; run npm run setup:scriptc first');

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', ...options });
  assert.equal(result.status, 0, `${command} ${args.join(' ')}: ${result.error ?? result.stderr}\n${result.stdout}`);
  return result.stdout;
};

// Preserve TypeScript types and the module graph. Feeding esbuild's erased JS
// back into the TS compiler loses the shapes scriptc needs for native lowering.
const packageInfo = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const compilerVersion = JSON.parse(fs.readFileSync(path.join(root, 'toolchains/scriptc/package.json'), 'utf8')).dependencies.scriptc;
assert.equal(run(compiler, ['--version']).trim(), compilerVersion, 'run setup:scriptc to install the pinned compiler');
const manifests = loadManifests(path.resolve(root, '..', 'subprojects'));
assert.equal(manifests.issues.length, 0, 'native metadata must contain valid manifests');
assert.ok(manifests.tools.length > 0, 'native metadata must contain tools');
// Stage beneath the package so @types/node resolves from its node_modules.
const temporary = fs.mkdtempSync(path.join(root, '.scriptc-native-'));
try {
  const stagedSources = path.join(temporary, 'src');
  fs.cpSync(path.join(root, 'src'), stagedSources, { recursive: true });
  fs.copyFileSync(path.join(root, 'scripts/native/transport.ts'), path.join(stagedSources, 'transport.ts'));
  const ffiArgs = [];
  if (process.platform === 'win32') {
    fs.copyFileSync(path.join(root, 'scripts/native/windows-process.ts'), path.join(stagedSources, 'windows-process.ts'));
    const object = path.join(temporary, 'windows-process.obj');
    run('zig', ['cc', '-target', 'x86_64-windows-gnu', '-c', path.join(root, 'scripts/native/windows-process.c'), '-o', object, '-O2', '-Wall', '-Wextra', '-Werror']);
    const ffi = path.join(temporary, 'ffi.json');
    fs.writeFileSync(ffi, JSON.stringify({
      ffi_format: 1,
      functions: [{ name: 'decxWindowsRun', symbol: 'decx_windows_run',
        params: ['string', 'string', 'string', 'string', 'string', 'i32', 'i32'], returns: 'f64' }],
      libraries: [object], system_libraries: ['kernel32'],
    }));
    ffiArgs.push('--ffi', ffi);
  }
  // scriptc lowers builtin namespace imports, not Node's default module objects.
  // Keep this adaptation in staging: Node tests patch the live default objects.
  for (const name of fs.readdirSync(stagedSources)) {
    if (!name.endsWith('.ts')) continue;
    const file = path.join(stagedSources, name);
    const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    let adapted = text.replace(/^import (\w+) from ('node:[^']+');$/gm, 'import * as $1 from $2;');
    if (name === 'install.ts') {
      // This option is not lowered by scriptc. Windows uses an in-binary Win32
      // FFI bridge for verbatim cmd lines; all other launches use native spawn.
      assert.equal(adapted.split('windowsVerbatimArguments: spec.windowsVerbatimArguments === true,').length, 3);
      adapted = adapted.replace(/^\s*windowsVerbatimArguments: spec\.windowsVerbatimArguments === true,\n/gm, '\n');
      assert.doesNotMatch(adapted, /windowsVerbatimArguments:/, 'unsupported spawn option must be removed');
      if (process.platform === 'win32') {
        adapted = `import { runWindowsVerbatim } from './windows-process.ts';\n${adapted}`;
        const marker = 'export async function defaultRunner(spec: CommandSpec): Promise<CommandResult> {';
        assert.equal(adapted.split(marker).length, 2);
        adapted = adapted.replace(marker, `${marker}\n  if (spec.windowsVerbatimArguments === true) return await runWindowsVerbatim(spec);`);
      }
    }
    fs.writeFileSync(file, adapted);
  }
  const source = path.join(stagedSources, 'cli.ts');
  let entry = fs.readFileSync(source, 'utf8');
  const replace = (before, after) => {
    assert.equal(entry.split(before).length, 2, `native source marker changed: ${before}`);
    entry = entry.replace(before, after);
  };
  replace('declare const __DECX_VERSION__: string;', `const __DECX_VERSION__: string = ${JSON.stringify(packageInfo.version)};`);
  replace('declare const __DECX_MANIFESTS__: LoadResult;', `const __DECX_MANIFESTS__: LoadResult = ${JSON.stringify(manifests)};`);
  replace("typeof __DECX_VERSION__ !== 'undefined'", 'true');
  replace("typeof __DECX_MANIFESTS__ !== 'undefined'", 'true');
  // import.meta.url points to the build-time source under scriptc, not the exe.
  replace('if (isEntryPoint()) {', 'if (true) {');
  assert.equal(entry.split('node: process.versions.node').length, 3, 'native version markers changed');
  entry = entry.replaceAll('node: process.versions.node', `runtime: 'scriptc', compiler: ${JSON.stringify(compilerVersion)}`);
  fs.writeFileSync(source, entry);
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  const name = `decx-${platform}${process.platform === 'win32' ? '.exe' : ''}`;
  const destination = path.join(root, 'dist', name);
  const binary = path.join(temporary, name);
  // Never leave an old launcher or an unverified binary in the release directory.
  fs.rmSync(destination, { force: true });
  run(compiler, ['build', source, '-o', binary, '--no-keep-llvm', '--dynamic', ...ffiArgs], { timeout: 180_000 });
  const smokeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'decx-native-smoke-'));
  try {
    // A successful build must run without Node on PATH or the source checkout.
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
