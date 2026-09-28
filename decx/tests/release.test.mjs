import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const distRoot = path.join(packageRoot, 'dist');
const artifactRoot = path.join(packageRoot, 'artifacts');
const packageInfo = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  assert.equal(result.status, 0, `${command} ${args.join(' ')}: ${result.error ?? result.stderr}`);
  return result.stdout;
};

test('release builds one executable with embedded metadata and packs that file', () => {
  const script = (name, args = []) => run(process.execPath, [path.join(packageRoot, 'scripts', name), ...args]);
  script('build.mjs');
  assert.deepEqual(fs.readdirSync(distRoot), ['decx.mjs']);
  assert.match(fs.readFileSync(path.join(distRoot, 'decx.mjs'), 'utf8'), /^#!\/usr\/bin\/env node\n/);
  script('pack.mjs');
  const name = `decx-${packageInfo.version}`;
  const archive = path.join(artifactRoot, `${name}.tar.gz`);
  const entries = run('tar', ['-tzf', path.basename(archive)], { cwd: artifactRoot }).trim().split(/\r?\n/).filter((entry) => !entry.endsWith('/')).sort();
  assert.deepEqual(entries, [`${name}/LICENSE`, `${name}/README.md`, `${name}/decx.mjs`]);
  assert.equal(fs.readFileSync(path.join(artifactRoot, 'decx-SHA256SUMS.txt'), 'utf8'),
    `${createHash('sha256').update(fs.readFileSync(archive)).digest('hex')}  ${name}.tar.gz\n`);
});
