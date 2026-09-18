#!/usr/bin/env node
/**
 * Pack `dist/` into `artifacts/decx-<version>.tar.gz` (single `decx-<version>/`
 * root directory, plus the repo LICENSE and this README) and write
 * `artifacts/decx-SHA256SUMS.txt` in the `sha256  filename` format the
 * manager's checksum parser understands.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { artifactRoot, distRoot, packageInfo, packageRoot, repoRoot, run } from './common.mjs';

if (!fs.existsSync(path.join(distRoot, 'decx', 'lib', 'cli.js'))) {
  throw new Error('dist/ is empty; run `npm run build` first');
}

const { version } = packageInfo();
const name = `decx-${version}`;
const stage = path.join(artifactRoot, name);
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(artifactRoot, { recursive: true });
fs.cpSync(distRoot, stage, { recursive: true });
fs.copyFileSync(path.join(repoRoot, 'LICENSE'), path.join(stage, 'LICENSE'));
fs.copyFileSync(path.join(packageRoot, 'README.md'), path.join(stage, 'README.md'));

const tarball = path.join(artifactRoot, `${name}.tar.gz`);
fs.rmSync(tarball, { force: true });
// bsdtar on Windows and GNU tar on Linux/macOS both support -czf/-C.
run('tar', ['-czf', tarball, '-C', artifactRoot, name]);
fs.rmSync(stage, { recursive: true, force: true });

const sha256 = createHash('sha256').update(fs.readFileSync(tarball)).digest('hex');
const checksums = path.join(artifactRoot, 'decx-SHA256SUMS.txt');
fs.writeFileSync(checksums, `${sha256}  ${name}.tar.gz\n`);

console.log(`packed ${path.basename(tarball)} (${sha256})`);
