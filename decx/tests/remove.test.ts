import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { removeTool } from '../src/remove.ts';
import { createLinks } from '../src/links.ts';
import type { ToolManifest } from '../src/manifest.ts';

const manifest = { manifest: 2, id: 'demo', install: ['pip', 'install', '{source}'], launch: { type: 'python', commands: ['demo'] }, summary: 'demo', release: { repository: 'example/demo', tagPrefix: 'demo-v', checksums: 'SHA256SUMS', asset: 'demo.zip' } } satisfies ToolManifest;

test('remove deletes recorded payload, runtime and owned links but leaves unrelated files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'decx-remove-'));
  try {
    const home = path.join(root, 'home');
    const linkDir = path.join(root, 'links');
    fs.mkdirSync(path.join(home, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(home, 'share', 'demo'), { recursive: true });
    fs.mkdirSync(path.join(home, 'runtime', 'demo'), { recursive: true });
    fs.writeFileSync(path.join(home, 'bin', 'demo'), 'launcher');
    fs.writeFileSync(path.join(home, 'bin', 'other'), 'foreign');
    fs.writeFileSync(path.join(home, 'share', 'demo', 'PROVENANCE'), `tool: demo\nbinaries: demo\nlink_dir: ${linkDir}\n`);
    createLinks({ home, files: ['demo'], linkDir, windows: false });
    fs.writeFileSync(path.join(linkDir, 'unrelated'), 'foreign');
    const result = removeTool({ ...manifest, launch: { type: 'python', commands: ['renamed'] } }, home);
    assert.equal(result.id, 'demo');
    assert.equal(fs.existsSync(path.join(home, 'share', 'demo')), false);
    assert.equal(fs.existsSync(path.join(home, 'runtime', 'demo')), false);
    assert.equal(fs.existsSync(path.join(home, 'bin', 'demo')), false);
    assert.equal(fs.existsSync(path.join(linkDir, 'demo')), false);
    assert.equal(fs.readFileSync(path.join(home, 'bin', 'other'), 'utf8'), 'foreign');
    assert.equal(fs.readFileSync(path.join(linkDir, 'unrelated'), 'utf8'), 'foreign');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
