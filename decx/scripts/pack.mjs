#!/usr/bin/env node
/**
 * Pack `dist/` into `artifacts/decx-<version>.tar.gz` (single `decx-<version>/`
 * root directory, plus the repo LICENSE and this README), a separate
 * `decx-pi-<version>.tar.gz` extension/skills package, and SHA256SUMS files
 * in the `sha256  filename` format the manager's parser understands.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const repoRoot = path.resolve(packageRoot, '..');
const distRoot = path.join(packageRoot, 'dist');
const artifactRoot = path.join(packageRoot, 'artifacts');
const packageInfo = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', cwd: artifactRoot });
  if (result.error || result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${result.status}): ${result.error?.message ?? ''}\n${result.stdout ?? ''}${result.stderr ?? ''}`);
}
if (!fs.existsSync(path.join(distRoot, 'decx.mjs'))) {
  throw new Error('dist/ is empty; run `npm run build` first');
}

const { version } = packageInfo;
const name = `decx-${version}`;
const stage = path.join(artifactRoot, name);
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(artifactRoot, { recursive: true });
fs.mkdirSync(stage, { recursive: true });
fs.copyFileSync(path.join(distRoot, 'decx.mjs'), path.join(stage, 'decx.mjs'));
fs.copyFileSync(path.join(repoRoot, 'LICENSE'), path.join(stage, 'LICENSE'));
fs.copyFileSync(path.join(packageRoot, 'README.md'), path.join(stage, 'README.md'));

const tarball = path.join(artifactRoot, `${name}.tar.gz`);
fs.rmSync(tarball, { force: true });
// Use relative archive paths: Windows tar treats the colon in C:\\ as a remote host separator.
run('tar', ['-czf', path.basename(tarball), name]);
fs.rmSync(stage, { recursive: true, force: true });

const sha256 = createHash('sha256').update(fs.readFileSync(tarball)).digest('hex');
const checksums = path.join(artifactRoot, 'decx-SHA256SUMS.txt');
fs.writeFileSync(checksums, `${sha256}  ${name}.tar.gz\n`);

console.log(`packed ${path.basename(tarball)} (${sha256})`);

// The pi integration is a separate, self-contained package: it can be unpacked
// into any project and installed by path, without cloning this repository.
const piName = `decx-pi-${version}`;
const piStage = path.join(artifactRoot, piName);
fs.rmSync(piStage, { recursive: true, force: true });
fs.mkdirSync(path.join(piStage, 'extensions'), { recursive: true });
fs.mkdirSync(path.join(piStage, 'skills'), { recursive: true });
fs.cpSync(path.join(repoRoot, '.pi', 'extensions', 'decx'), path.join(piStage, 'extensions', 'decx'), {
  recursive: true,
  filter: (source) => !source.endsWith('.test.ts'),
});
for (const entry of fs.readdirSync(path.join(repoRoot, 'skills'), { withFileTypes: true })) {
  if (entry.isDirectory() && fs.existsSync(path.join(repoRoot, 'skills', entry.name, 'SKILL.md'))) {
    fs.cpSync(path.join(repoRoot, 'skills', entry.name), path.join(piStage, 'skills', entry.name), { recursive: true });
  }
}
fs.writeFileSync(path.join(piStage, 'package.json'), `${JSON.stringify({
  name: '@jygzyc/decx-pi', version, private: true, type: 'module',
  engines: { node: '>=24.21.0' },
  peerDependencies: { '@earendil-works/pi-coding-agent': '*', typebox: '*' },
  pi: { extensions: ['./extensions/decx/index.ts'], skills: [] }, // npx skills installs the bundled execution skill separately
}, null, 2)}\n`);
fs.copyFileSync(path.join(repoRoot, 'LICENSE'), path.join(piStage, 'LICENSE'));
const piTarball = path.join(artifactRoot, `${piName}.tar.gz`);
fs.rmSync(piTarball, { force: true });
try {
  run('tar', ['-czf', path.basename(piTarball), piName]);
} finally {
  fs.rmSync(piStage, { recursive: true, force: true });
}
const piDigest = createHash('sha256').update(fs.readFileSync(piTarball)).digest('hex');
fs.writeFileSync(path.join(artifactRoot, 'decx-pi-SHA256SUMS.txt'), `${piDigest}  ${piName}.tar.gz\n`);
console.log(`packed ${path.basename(piTarball)} (${piDigest})`);
