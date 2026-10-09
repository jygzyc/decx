#!/usr/bin/env node
/** Install a pinned official native SDK, verified before extraction. No npm lifecycle code. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractArchive } from '../src/archive.ts';

export async function installSdk(root, {
  download = fetch,
  verify = (compiler) => spawnSync(compiler, ['--version'], { encoding: 'utf8', timeout: 30_000 }),
} = {}) {
  const pin = JSON.parse(fs.readFileSync(path.join(root, 'toolchains/scriptc/toolchain.json'), 'utf8'));
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
    // Keep one compiler filename on every host, matching the build/test helpers.
    if (process.platform !== 'win32') {
      fs.renameSync(path.join(staged, 'bin/scriptc'), path.join(staged, 'bin/scriptc.exe'));
      fs.renameSync(path.join(staged, 'bin/scriptc.json'), path.join(staged, 'bin/scriptc.exe.json'));
    }
    const compiler = path.join(staged, 'bin/scriptc.exe');
    const metadata = JSON.parse(fs.readFileSync(`${compiler}.json`, 'utf8'));
    assert.equal(metadata.schema, 'scriptc.native-toolchain.v1');
    assert.equal(metadata.compiler_version, pin.version);
    const result = verify(compiler);
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await installSdk(fileURLToPath(new URL('../', import.meta.url)));
}
