/**
 * Archive extraction tests: tar.gz and zip, built in-test with node:zlib so
 * the suite never touches the network.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { ArchiveError, extractArchive, extractTarGz, extractZip } from '../src/archive.ts';
import { makeTarGz, makeZip, tempDir, writeFile } from './fixtures.ts';

function read(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

test('tar.gz extraction handles nested directories, modes and symlinks', () => {
  const root = tempDir('decx-archive-tar-');
  const archive = path.join(root, 'demo.tar.gz');
  writeFile(
    archive,
    makeTarGz([
      { name: 'bin/demo', data: '#!/bin/sh\n', mode: 0o755 },
      { name: 'share/demo/README.md', data: 'readme\n' },
      { name: 'empty', type: 'dir' },
      ...(process.platform === 'win32' ? [] : [{ name: 'bin/link', type: 'symlink' as const, link: 'demo' }]),
    ]),
  );
  const dest = path.join(root, 'out');
  extractTarGz(archive, dest);

  assert.equal(read(path.join(dest, 'bin/demo')), '#!/bin/sh\n');
  assert.equal(read(path.join(dest, 'share/demo/README.md')), 'readme\n');
  assert.ok(fs.statSync(path.join(dest, 'empty')).isDirectory());
  if (process.platform !== 'win32') {
    assert.ok(fs.statSync(path.join(dest, 'bin/demo')).mode & 0o111);
    assert.equal(fs.readlinkSync(path.join(dest, 'bin/link')), 'demo');
  }
});

test('tar.gz extraction honours PAX path records', () => {
  const root = tempDir('decx-archive-pax-');
  const longName = `${'nested/'.repeat(10)}deep.txt`;
  const archive = path.join(root, 'pax.tar.gz');
  writeFile(archive, makeTarGz([{ name: 'placeholder.txt', paxPath: longName, data: 'pax\n' }]));
  const dest = path.join(root, 'out');
  extractTarGz(archive, dest);
  assert.equal(read(path.join(dest, ...longName.split('/'))), 'pax\n');
});

test('tar.gz extraction rejects path traversal and absolute paths', () => {
  const root = tempDir('decx-archive-escape-');
  const traversal = path.join(root, 'traversal.tar.gz');
  writeFile(traversal, makeTarGz([{ name: '../escape.txt', data: 'nope' }]));
  assert.throws(() => extractTarGz(traversal, path.join(root, 'out')), ArchiveError);

  const absolute = path.join(root, 'absolute.tar.gz');
  writeFile(absolute, makeTarGz([{ name: '/etc/passwd', data: 'nope' }]));
  assert.throws(() => extractTarGz(absolute, path.join(root, 'out2')), ArchiveError);
});

test('tar.gz extraction rejects symlinks that escape the destination', () => {
  if (process.platform === 'win32') {
    return;
  }
  const root = tempDir('decx-archive-link-');
  const archive = path.join(root, 'link.tar.gz');
  writeFile(archive, makeTarGz([{ name: 'bin/escape', type: 'symlink', link: '../../outside' }]));
  assert.throws(() => extractTarGz(archive, path.join(root, 'out')), ArchiveError);
});

test('zip extraction handles stored and deflated entries plus modes', () => {
  const root = tempDir('decx-archive-zip-');
  const archive = path.join(root, 'demo.zip');
  writeFile(
    archive,
    makeZip([
      { name: 'demo.exe', data: 'MZ fake binary\n'.repeat(20), mode: 0o755 },
      { name: 'docs/', mode: 0o755 },
      { name: 'docs/README.md', data: 'stored\n', stored: true },
    ]),
  );
  const dest = path.join(root, 'out');
  extractZip(archive, dest);

  assert.equal(read(path.join(dest, 'demo.exe')), 'MZ fake binary\n'.repeat(20));
  assert.ok(fs.statSync(path.join(dest, 'docs')).isDirectory());
  assert.equal(read(path.join(dest, 'docs/README.md')), 'stored\n');
  if (process.platform !== 'win32') {
    assert.ok(fs.statSync(path.join(dest, 'demo.exe')).mode & 0o111);
  }
});

test('zip extraction rejects path traversal', () => {
  const root = tempDir('decx-archive-zip-escape-');
  const archive = path.join(root, 'evil.zip');
  writeFile(archive, makeZip([{ name: '../evil.exe', data: 'nope' }]));
  assert.throws(() => extractZip(archive, path.join(root, 'out')), ArchiveError);
});

test('extractArchive dispatches on the extension', () => {
  const root = tempDir('decx-archive-dispatch-');
  const tar = path.join(root, 'a.tar.gz');
  writeFile(tar, makeTarGz([{ name: 'a.txt', data: 'a' }]));
  extractArchive(tar, path.join(root, 'tar-out'));
  assert.equal(read(path.join(root, 'tar-out/a.txt')), 'a');

  const zip = path.join(root, 'b.zip');
  writeFile(zip, makeZip([{ name: 'b.txt', data: 'b' }]));
  extractArchive(zip, path.join(root, 'zip-out'));
  assert.equal(read(path.join(root, 'zip-out/b.txt')), 'b');
});
