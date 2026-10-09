/**
 * Archive extraction tests: tar.gz and zip, built in-test with node:zlib so
 * the suite never touches the network.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mockBuiltin } from './builtin-mock.ts';
import path from 'node:path';
import test from 'node:test';
import { gunzipSync, gzipSync } from 'node:zlib';
import { ArchiveError, extractArchive, extractTarGz, extractZip } from '../src/archive.ts';
import { makeTarGz, makeZip, tempDir, writeFile, type TarEntry } from './fixtures.ts';

function read(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

/** Extend the shared fixture locally with tar hard links (typeflag 1). */
function makeTarWithLinks(entries: readonly (Omit<TarEntry, 'type'> & { type?: TarEntry['type'] | 'hardlink' })[]): Buffer {
  const chunks = entries.map((entry) => {
    const buffer = gunzipSync(makeTarGz([{ ...entry, type: entry.type === 'hardlink' ? 'symlink' : entry.type ?? 'file' }]));
    if (entry.type === 'hardlink') {
      // Hard links have no body; the final header follows any PAX metadata.
      const header = buffer.subarray(buffer.length - 1536, buffer.length - 1024);
      header.write('1', 156, 1);
      header.fill(0x20, 148, 156);
      const checksum = header.reduce((sum, byte) => sum + byte, 0);
      header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8);
    }
    return buffer.subarray(0, buffer.length - 1024);
  });
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
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

test('tar.gz extraction rejects a symlink chain before it can write outside', { skip: process.platform === 'win32' }, (t) => {
  const root = tempDir('decx-archive-chain-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archive = path.join(root, 'chain.tar.gz');
  const outside = path.join(root, 'outside');
  writeFile(path.join(outside, 'existing.txt'), 'untouched');
  writeFile(archive, makeTarGz([
    { name: 'pivot', type: 'symlink', link: '.' },
    // Lexically pivot/.. is out, but pivot is out itself: this creates out/up -> .. .
    { name: 'placeholder', paxPath: 'pivot/up', type: 'symlink', link: '..' },
    { name: 'up/outside/existing.txt', data: 'overwritten' },
    { name: 'up/outside/new/deep/file.txt', data: 'escaped' },
  ]));

  assert.throws(() => extractTarGz(archive, path.join(root, 'out')), ArchiveError);
  assert.equal(read(path.join(outside, 'existing.txt')), 'untouched');
  assert.equal(fs.existsSync(path.join(outside, 'new')), false);
});

for (const forward of [false, true]) {
  for (const dangling of [false, true]) {
    test(`tar.gz extraction rejects escaping link targets (forward: ${forward}, dangling: ${dangling})`, { skip: process.platform === 'win32' }, (t) => {
      const root = tempDir('decx-archive-link-target-');
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const archive = path.join(root, 'chain.tar.gz');
      const pivot: TarEntry = { name: 'pivot', type: 'symlink', link: '.' };
      const up: TarEntry = { name: 'up', type: 'symlink', link: dangling ? 'pivot/../missing' : 'pivot/..' };
      writeFile(path.join(root, 'sentinel'), 'outside');
      writeFile(archive, makeTarGz(forward ? [up, pivot] : [pivot, up]));

      // No write through up is needed: a consumer could otherwise read outside.
      assert.throws(() => extractTarGz(archive, path.join(root, 'out')), {
        name: 'ArchiveError',
        message: /symlink escapes the destination/,
      });
      assert.equal(read(path.join(root, 'sentinel')), 'outside');
      assert.equal(fs.existsSync(path.join(root, 'missing')), false);
    });
  }
}

test('tar.gz extraction rejects escaping multi-hop forward references', { skip: process.platform === 'win32' }, (t) => {
  const root = tempDir('decx-archive-forward-chain-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archive = path.join(root, 'chain.tar.gz');
  writeFile(archive, makeTarGz([
    { name: 'up', type: 'symlink', link: 'first/..' },
    { name: 'first', type: 'symlink', link: 'second' },
    { name: 'second', type: 'symlink', link: '.' },
  ]));
  assert.throws(() => extractTarGz(archive, path.join(root, 'out')), ArchiveError);
});

for (const links of [
  [{ name: 'self', type: 'symlink', link: 'self' }],
  [{ name: 'first', type: 'symlink', link: 'second' }, { name: 'second', type: 'symlink', link: 'first' }],
] as const) {
  test(`tar.gz extraction rejects cyclic symlink targets (${links.length} links)`, { skip: process.platform === 'win32' }, (t) => {
    const root = tempDir('decx-archive-cycle-');
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const archive = path.join(root, 'cycle.tar.gz');
    writeFile(archive, makeTarGz(links));
    assert.throws(() => extractTarGz(archive, path.join(root, 'out')), {
      name: 'ArchiveError',
      message: /cyclic or too deep/,
    });
  });
}

test('tar.gz extraction resolves legitimate forward links before parent components', { skip: process.platform === 'win32' }, (t) => {
  const root = tempDir('decx-archive-safe-chain-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archive = path.join(root, 'safe.tar.gz');
  const dest = path.join(root, 'out');
  writeFile(archive, makeTarGz([
    { name: 'package/tool', type: 'symlink', link: 'alias/../tool' },
    { name: 'package/alias', type: 'symlink', link: '../target/sub' },
    { name: 'target/sub', type: 'dir' },
    { name: 'target/tool', data: 'content' },
    { name: 'pivot', type: 'symlink', link: '.' },
    { name: 'repeated', type: 'symlink', link: 'pivot/pivot/target/tool' },
    { name: 'dangling', type: 'symlink', link: 'target/not-installed' },
  ]));

  extractTarGz(archive, dest);
  assert.equal(read(path.join(dest, 'package/tool')), 'content');
  assert.equal(read(path.join(dest, 'repeated')), 'content');
  assert.equal(fs.readlinkSync(path.join(dest, 'dangling')), 'target/not-installed');
});

for (const type of ['file', 'dir', 'symlink', 'hardlink'] as const) {
  test(`tar.gz extraction rejects symlink ancestors for ${type} entries`, (t) => {
    const root = tempDir('decx-archive-ancestor-');
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const dest = path.join(root, 'out');
    // Use a sibling with the same prefix to catch string-prefix containment checks.
    const outside = path.join(root, 'out-other');
    fs.mkdirSync(dest);
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(dest, 'pivot'), process.platform === 'win32' ? 'junction' : 'dir');
    const archive = path.join(root, 'ancestor.tar.gz');
    writeFile(archive, makeTarWithLinks([
      { name: 'source', data: 'source' },
      { name: 'pivot/new/entry', type, link: type === 'symlink' ? '../../source' : 'source', data: 'escaped' },
    ]));

    assert.throws(() => extractTarGz(archive, dest), ArchiveError);
    assert.deepEqual(fs.readdirSync(outside), []);
  });
}

for (const type of ['file', 'dir', 'hardlink'] as const) {
  test(`tar.gz extraction rejects a symlink at the ${type} destination`, { skip: process.platform === 'win32' }, (t) => {
    const root = tempDir('decx-archive-leaf-');
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const archive = path.join(root, 'leaf.tar.gz');
    const dest = path.join(root, 'out');
    writeFile(archive, makeTarWithLinks([
      { name: 'source', data: 'original' },
      { name: 'directory', type: 'dir', mode: 0o755 },
      { name: 'alias', type: 'symlink', link: type === 'dir' ? 'directory' : 'source' },
      { name: 'alias', type, link: 'source', data: 'replacement', mode: 0o700 },
    ]));

    assert.throws(() => extractTarGz(archive, dest), ArchiveError);
    assert.equal(read(path.join(dest, 'source')), 'original');
    assert.equal(fs.statSync(path.join(dest, 'directory')).mode & 0o777, 0o755);
    assert.ok(fs.lstatSync(path.join(dest, 'alias')).isSymbolicLink());
  });
}

test('tar.gz extraction rejects writes through dangling symlinks', { skip: process.platform === 'win32' }, (t) => {
  const root = tempDir('decx-archive-dangling-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archive = path.join(root, 'dangling.tar.gz');
  const dest = path.join(root, 'out');
  writeFile(archive, makeTarGz([
    { name: 'alias', type: 'symlink', link: 'missing' },
    { name: 'alias', data: 'replacement' },
  ]));

  assert.throws(() => extractTarGz(archive, dest), ArchiveError);
  assert.equal(fs.existsSync(path.join(dest, 'missing')), false);
});

test('tar.gz extraction rejects hard link sources with symlink ancestors', (t) => {
  const root = tempDir('decx-archive-hardlink-parent-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dest = path.join(root, 'out');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(dest);
  writeFile(path.join(outside, 'source'), 'untouched');
  fs.symlinkSync(outside, path.join(dest, 'pivot'), process.platform === 'win32' ? 'junction' : 'dir');
  const archive = path.join(root, 'hardlink.tar.gz');
  writeFile(archive, makeTarWithLinks([
    { name: 'alias', type: 'hardlink', link: 'pivot/source' },
    { name: 'alias', data: 'overwritten' },
  ]));

  assert.throws(() => extractTarGz(archive, dest), ArchiveError);
  assert.equal(read(path.join(outside, 'source')), 'untouched');
  assert.equal(fs.existsSync(path.join(dest, 'alias')), false);
});

test('tar.gz extraction rejects hard links to symlink entries', { skip: process.platform === 'win32' }, (t) => {
  const root = tempDir('decx-archive-hardlink-symlink-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archive = path.join(root, 'hardlink.tar.gz');
  const dest = path.join(root, 'out');
  writeFile(archive, makeTarWithLinks([
    { name: 'source', data: 'original' },
    { name: 'link', type: 'symlink', link: 'source' },
    { name: 'alias', type: 'hardlink', link: 'link' },
  ]));

  assert.throws(() => extractTarGz(archive, dest), ArchiveError);
  assert.equal(fs.existsSync(path.join(dest, 'alias')), false);
  assert.equal(read(path.join(dest, 'source')), 'original');
});

test('tar.gz extraction preserves upstream-style relative and forward symlinks', { skip: process.platform === 'win32' }, (t) => {
  const root = tempDir('decx-archive-upstream-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archive = path.join(root, 'upstream.tar.gz');
  const dest = path.join(root, 'out');
  writeFile(archive, makeTarGz([
    { name: './', type: 'dir' },
    { name: './package/bin/demo', type: 'symlink', link: '../lib/demo' },
    { name: './package/lib/libdemo.so', type: 'symlink', link: 'libdemo.so.1' },
    { name: './package/lib/libdemo.so.1', type: 'symlink', link: 'libdemo.so.1.2' },
    { name: './package/current', type: 'symlink', link: 'lib' },
    { name: './package/lib/demo', data: 'executable', mode: 0o755 },
    { name: './package/lib/libdemo.so.1.2', data: 'library' },
    { name: './package/bin/', type: 'dir' },
  ]));

  extractTarGz(archive, dest);
  assert.equal(fs.readlinkSync(path.join(dest, 'package/bin/demo')), '../lib/demo');
  assert.equal(read(path.join(dest, 'package/bin/demo')), 'executable');
  assert.equal(read(path.join(dest, 'package/lib/libdemo.so')), 'library');
  assert.equal(read(path.join(dest, 'package/current/libdemo.so')), 'library');
  assert.ok(fs.statSync(path.join(dest, 'package/lib/demo')).mode & 0o111);
});

for (const copyFallback of [false, true]) {
  test(`tar.gz extraction preserves regular hard links (copy fallback: ${copyFallback})`, (t) => {
    const root = tempDir('decx-archive-hardlink-');
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    if (copyFallback) {
      mockBuiltin(t)(fs, 'linkSync', () => { throw new Error('hard links unavailable'); });
    }
    const archive = path.join(root, 'hardlink.tar.gz');
    const dest = path.join(root, 'out');
    writeFile(archive, makeTarWithLinks([
      { name: 'lib/source', data: 'content', mode: 0o755 },
      { name: 'bin/alias', type: 'hardlink', link: './lib/source' },
    ]));

    extractTarGz(archive, dest);
    assert.equal(read(path.join(dest, 'bin/alias')), 'content');
    if (!copyFallback) {
      assert.equal(fs.statSync(path.join(dest, 'bin/alias')).ino, fs.statSync(path.join(dest, 'lib/source')).ino);
    }
  });
}

test('tar.gz extraction accepts a destination reached through a symlink', (t) => {
  const root = tempDir('decx-archive-root-link-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const actual = path.join(root, 'actual');
  const alias = path.join(root, 'alias');
  fs.mkdirSync(actual);
  fs.symlinkSync(actual, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const archive = path.join(root, 'demo.tar.gz');
  writeFile(archive, makeTarGz([
    { name: './', type: 'dir' },
    { name: './bin/demo', data: 'content' },
    { name: './bin/', type: 'dir' },
  ]));

  for (const dest of [alias, path.join(alias, 'nested')]) {
    extractTarGz(archive, dest);
    assert.equal(read(path.join(dest, 'bin/demo')), 'content');
  }
  assert.equal(read(path.join(actual, 'bin/demo')), 'content');
  assert.equal(read(path.join(actual, 'nested/bin/demo')), 'content');
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
