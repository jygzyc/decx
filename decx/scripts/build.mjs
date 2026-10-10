#!/usr/bin/env node
/** Bundle the CLI and its metadata into one portable Node ESM executable. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { loadManifests } from '../src/catalog/manifest.ts';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const repoRoot = path.resolve(packageRoot, '..');
const distRoot = path.join(packageRoot, 'dist');
const packageInfo = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));

const manifests = loadManifests(path.join(repoRoot, 'third_party'));
if (manifests.issues.length || manifests.tools.length === 0) {
  throw new Error(`cannot bundle tool manifests: ${JSON.stringify(manifests)}`);
}
fs.rmSync(distRoot, { recursive: true, force: true });
const outfile = path.join(distRoot, 'decx.mjs');
await build({
  entryPoints: [path.join(packageRoot, 'src', 'cli.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  define: {
    __DECX_VERSION__: JSON.stringify(packageInfo.version),
    __DECX_MANIFESTS__: JSON.stringify(manifests),
  },
});
fs.chmodSync(outfile, 0o755);
console.log(`built dist/decx.mjs (embedded ${manifests.tools.length} tool manifests)`);

// Smoke the single-file output in an isolated temporary directory.
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'decx-smoke-'));
try {
  const cli = path.join(cwd, 'decx.mjs');
  fs.copyFileSync(outfile, cli);
  const env = { ...process.env, HOME: cwd, USERPROFILE: cwd, DECX_HOME: path.join(cwd, 'home'), DECX_LINKS_DIR: path.join(cwd, 'links') };
  const run = (args, status = 0) => {
    const result = spawnSync(process.execPath, [cli, ...args], { cwd, env, encoding: 'utf8' });
    assert.equal(result.status, status, `${args}: ${result.error ?? result.stderr}\n${result.stdout}`);
    return result.stdout;
  };
  const version = JSON.parse(run(['version']));
  assert.equal(version.ok, true);
  assert.equal(version.version, packageInfo.version);
  assert.match(run(['help']), /usage: decx/);
  assert.equal(JSON.parse(run(['list'], 2)).error.code, 'UNKNOWN_TOOL');
  for (const id of ['afe', 'droidasc', 'kuna']) assert.equal(JSON.parse(run(['-m', id], 1)).error.code, 'NOT_INSTALLED');
  assert.equal(JSON.parse(run(['install'], 2)).error.code, 'USAGE');
  assert.deepEqual(fs.readdirSync(cwd), ['decx.mjs']);
  const override = path.join(cwd, 'custom');
  fs.mkdirSync(path.join(override, 'decx-fixture'), { recursive: true });
  fs.writeFileSync(path.join(override, 'decx-fixture', 'decx-fixture.json'), JSON.stringify({
    manifest: 2, id: 'fixture', summary: 'Offline fixture', install: ['github-release'], launch: { type: 'bin', commands: ['fixture'] }, release: { asset: 'fixture.zip' },
  }));
  assert.equal(JSON.parse(run(['--third-party', override, '-m', 'fixture'], 1)).error.code, 'NOT_INSTALLED');
  assert.equal(JSON.parse(run(['--third-party', override, '-m', 'afe'], 2)).error.code, 'UNKNOWN_TOOL');
  console.log(`smoke ok: decx ${version.version} (isolated single file)`);
} finally {
  fs.rmSync(cwd, { recursive: true, force: true });
}
