#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { windowsResource } from './windows-resource.mjs';

const compiler = fileURLToPath(new URL('../.scriptc-toolchain/node_modules/scriptc/bin/scriptc.exe', import.meta.url));
const args = process.argv.slice(2);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'decx-ts-tool-'));
try {
  if (process.platform === 'win32' && (!process.env.SCRIPTC_TARGET || process.env.SCRIPTC_TARGET.includes('windows'))) {
    const resource = windowsResource(temporary, (command, argv) => {
      const result = spawnSync(command, argv, { stdio: 'inherit' });
      if (result.status !== 0) throw new Error(`${command} failed: ${result.error ?? result.status}`);
    });
    // Keep user-supplied FFI bindings while rebasing relative library paths.
    const index = args.indexOf('--ffi');
    let manifest = { ffi_format: 1, functions: [], libraries: [], system_libraries: [] };
    if (index !== -1) {
      const original = path.resolve(args[index + 1]);
      manifest = JSON.parse(fs.readFileSync(original, 'utf8'));
      manifest.libraries = (manifest.libraries ?? []).map(library => path.resolve(path.dirname(original), library));
      args.splice(index, 2);
    }
    manifest.libraries.push(resource);
    const ffi = path.join(temporary, 'ffi.json');
    fs.writeFileSync(ffi, JSON.stringify(manifest));
    args.push('--ffi', ffi);
  }
  const result = spawnSync(compiler, ['build', ...args], { stdio: 'inherit' });
  if (result.error) console.error(`scriptc: ${result.error.message}; run npm run setup:scriptc first`);
  process.exitCode = result.status ?? 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
