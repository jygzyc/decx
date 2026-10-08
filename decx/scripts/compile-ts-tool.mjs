#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const compiler = fileURLToPath(new URL('../.scriptc-toolchain/node_modules/scriptc/bin/scriptc.exe', import.meta.url));
const result = spawnSync(compiler, ['build', ...process.argv.slice(2)], { stdio: 'inherit' });
if (result.error) {
  console.error(`scriptc: ${result.error.message}; run npm run setup:scriptc first`);
}
process.exitCode = result.status ?? 1;
