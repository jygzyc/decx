#!/usr/bin/env node
/** Install the separately locked compiler, then run its explicit native setup. */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const prefix = path.join(root, '.scriptc-toolchain');
const npm = process.env.npm_execpath;
if (!npm) throw new Error('run npm run setup:scriptc so the npm CLI path is available');
fs.mkdirSync(prefix, { recursive: true });
for (const name of ['package.json', 'package-lock.json']) {
  fs.copyFileSync(path.join(root, 'toolchains', 'scriptc', name), path.join(prefix, name));
}
const result = spawnSync(process.execPath, [npm, 'ci', '--prefix', prefix,
  '--ignore-scripts', '--no-audit', '--no-fund'], { stdio: 'inherit' });
if (result.status !== 0) throw new Error(`scriptc installation failed: ${result.error ?? result.status}`);
// Only this reviewed setup runs; dependency lifecycle scripts remain disabled.
const installer = await import(pathToFileURL(path.join(prefix, 'node_modules', 'scriptc', 'scripts', 'install-native.mjs')).href);
installer.installNativeCli(path.join(prefix, 'node_modules', 'scriptc'));
console.log('installed locked scriptc native compiler');
