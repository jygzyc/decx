import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { downloadAsset, GithubError } from '../src/download/github.ts';
import { extractTarGz, extractZip } from '../src/install/archive.ts';
import { createLinks, removeManagedLink, shimText } from '../src/install/links.ts';
import { makeTarGz, makeZip, sha256, startFixtureServer, tempDir, writeFile } from './fixtures.ts';

test('link reconciliation distinguishes ownership, exact targets and foreign backups', t => {
  const root = tempDir('decx-link-policy-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, '安装目录 with spaces');
  const linkDir = path.join(root, 'links');
  const target = path.join(home, 'bin', 'tool.cmd');
  const linked = path.join(linkDir, 'tool.cmd');
  writeFile(target, 'managed executable');
  const options = { home, linkDir, files: ['tool.cmd'], windows: true };
  assert.equal(createLinks(options)[0]?.status, 'created');
  assert.equal(createLinks(options)[0]?.status, 'unchanged');
  fs.writeFileSync(linked, shimText(path.join(home, 'bin', 'old.cmd')));
  assert.equal(removeManagedLink(linkDir, 'tool.cmd', target, true), false);
  assert.equal(createLinks(options)[0]?.status, 'updated');
  assert.equal(fs.readFileSync(linked, 'utf8'), shimText(target));
  assert.equal(removeManagedLink(linkDir, 'tool.cmd', target, true), true);
  fs.writeFileSync(linked, 'unrelated file');
  assert.equal(createLinks(options)[0]?.status, 'conflict');
  assert.equal(fs.readFileSync(linked, 'utf8'), 'unrelated file');
  assert.equal(createLinks({ ...options, force: true })[0]?.status, 'updated');
  assert.equal(fs.readFileSync(`${linked}.decx-old-${process.pid}`, 'utf8'), 'unrelated file');
  assert.equal(removeManagedLink(linkDir, 'tool.cmd', target, true), true);
  fs.mkdirSync(linked);
  assert.equal(removeManagedLink(linkDir, 'tool.cmd', target, true), false);
});

test('dangling owned symlinks can be refreshed but not removed as exact links', { skip: process.platform === 'win32' }, t => {
  const root = tempDir('decx-dangling-links-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const linkDir = path.join(root, 'links');
  const target = path.join(home, 'bin', 'tool');
  const linked = path.join(linkDir, 'tool');
  writeFile(target, 'managed executable');
  fs.mkdirSync(linkDir);
  fs.symlinkSync(path.join(home, 'bin', 'obsolete'), linked);
  assert.equal(removeManagedLink(linkDir, 'tool', target, false), false);
  assert.equal(createLinks({ home, linkDir, files: ['tool'], windows: false })[0]?.status, 'updated');
  assert.equal(fs.readlinkSync(linked), target);
  assert.equal(removeManagedLink(linkDir, 'tool', target, false), true);
});

test('stored and deflated ZIP entries retain data and CRC checks', t => {
  const root = tempDir('decx-zip-data-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archive = path.join(root, 'archive.zip');
  const dest = path.join(root, 'extract');
  const bytes = makeZip([{ name: 'stored', data: 'stored bytes', stored: true }, { name: 'deflated', data: 'deflated bytes' }]);
  fs.writeFileSync(archive, bytes);
  extractZip(archive, dest);
  assert.equal(fs.readFileSync(path.join(dest, 'stored'), 'utf8'), 'stored bytes');
  assert.equal(fs.readFileSync(path.join(dest, 'deflated'), 'utf8'), 'deflated bytes');
  const offset = bytes.indexOf(Buffer.from('stored bytes'));
  assert.ok(offset >= 0);
  bytes[offset] = (bytes[offset] ?? 0) ^ 1;
  fs.writeFileSync(archive, bytes);
  assert.throws(() => extractZip(archive, path.join(root, 'bad-crc')), /crc mismatch/);
});

test('TAR and ZIP reject writes through existing symlink components', { skip: process.platform === 'win32' }, t => {
  const root = tempDir('decx-archive-boundary-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dest = path.join(root, 'extract');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(dest);
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(dest, 'hop'));
  for (const [extension, bytes, extract] of [
    ['tar.gz', makeTarGz([{ name: 'hop/escape', data: 'not allowed' }]), extractTarGz],
    ['zip', makeZip([{ name: 'hop/escape', data: 'not allowed' }]), extractZip],
  ] as const) {
    const archive = path.join(root, `archive.${extension}`);
    fs.writeFileSync(archive, bytes);
    assert.throws(() => extract(archive, dest), /symlink path/);
    assert.equal(fs.existsSync(path.join(outside, 'escape')), false);
  }
});

test('stream downloads hash bytes and preserve local filesystem failures', async t => {
  const root = tempDir('decx-download-stream-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bytes = Buffer.alloc(256 * 1024, 0x61);
  const server = await startFixtureServer({ '/asset': bytes });
  t.after(() => server.close());
  const dest = path.join(root, 'download', 'asset');
  assert.deepEqual(await downloadAsset(`${server.url}/asset`, dest), { path: dest, bytes: bytes.length, sha256: sha256(bytes) });
  assert.deepEqual(fs.readFileSync(dest), bytes);
  const blocked = path.join(root, 'not-a-directory');
  fs.writeFileSync(blocked, 'keep me');
  await assert.rejects(downloadAsset(`${server.url}/asset`, path.join(blocked, 'asset')), error => {
    assert.ok(!(error instanceof GithubError));
    assert.ok(['ENOTDIR', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? ''));
    return true;
  });
  assert.equal(fs.readFileSync(blocked, 'utf8'), 'keep me');
  await assert.rejects(downloadAsset(`${server.url}/asset`, root), error => {
    assert.ok(!(error instanceof GithubError));
    assert.ok(['EISDIR', 'EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? ''));
    return true;
  });
});

test('interrupted downloads remove partial files and report network errors', async t => {
  const root = tempDir('decx-download-interrupted-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-length': '1000000' });
    response.write('partial bytes');
    setTimeout(() => response.destroy(), 20);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address !== null && typeof address !== 'string');
  const dest = path.join(root, 'partial');
  await assert.rejects(downloadAsset(`http://127.0.0.1:${address.port}/asset`, dest), error => {
    assert.ok(error instanceof GithubError);
    assert.equal(error.code, 'DOWNLOAD_FAILED');
    return true;
  });
  assert.equal(fs.existsSync(dest), false);
});

test('local write failures cancel an unfinished network body promptly', { timeout: 5_000 }, async t => {
  const root = tempDir('decx-download-write-error-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const server = http.createServer((_request, response) => {
    response.writeHead(200);
    response.write('body deliberately left open');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close(error => error ? reject(error) : resolve());
  }));
  const address = server.address();
  assert.ok(address !== null && typeof address !== 'string');
  await assert.rejects(downloadAsset(`http://127.0.0.1:${address.port}/asset`, root), error => {
    assert.ok(!(error instanceof GithubError));
    assert.ok(['EISDIR', 'EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? ''));
    return true;
  });
  assert.ok(fs.statSync(root).isDirectory());
});
