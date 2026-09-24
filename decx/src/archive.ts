/**
 * Archive extraction for the installer: `.tar.gz` (ustar, GNU and PAX headers)
 * and `.zip` (stored and deflate) using only node:zlib and node:fs.
 *
 * Every entry path is resolved inside the destination directory and symlink
 * targets must stay there too, so a hostile archive cannot write outside the
 * staging tree; both cases fail with an `ArchiveError` instead of silently
 * skipping the entry.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export class ArchiveError extends Error {
  readonly code = 'ARCHIVE_ERROR';

  constructor(message: string) {
    super(message);
    this.name = 'ArchiveError';
  }
}

/** Extracts by extension: `.zip` through the zip reader, anything else as tar.gz. */
export function extractArchive(archive: string, dest: string): void {
  if (archive.toLowerCase().endsWith('.zip')) {
    extractZip(archive, dest);
    return;
  }
  extractTarGz(archive, dest);
}

function resolveEntry(root: string, name: string): string {
  const normalized = name.replaceAll('\\', '/');
  if (normalized === '' || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw new ArchiveError(`archive entry has an absolute path: ${name}`);
  }
  const parts = normalized.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.includes('..')) {
    throw new ArchiveError(`archive entry escapes the destination: ${name}`);
  }
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, ...parts);
  if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new ArchiveError(`archive entry escapes the destination: ${name}`);
  }
  return target;
}

/** Never follow archive-created or pre-existing symlinks while materializing entries.
 * Check the leaf too: writeFile, chmod and the hard-link copy fallback follow it.
 * The root is canonical, so symlinks above the staging directory are harmless.
 */
function assertNoSymlinkPath(root: string, target: string): void {
  let current = root;
  for (const part of path.relative(root, target).split(path.sep)) {
    if (part === '') {
      continue;
    }
    current = path.join(current, part);
    const entry = fs.lstatSync(current, { throwIfNoEntry: false });
    if (entry === undefined) {
      // No descendant can exist yet; mkdir will create it below a checked parent.
      return;
    }
    if (entry.isSymbolicLink()) {
      throw new ArchiveError(`archive entry uses a symlink path: ${current}`);
    }
  }
}

function assertLinkInside(root: string, linkPath: string, linkName: string, target: string): void {
  const escape = () => new ArchiveError(`archive symlink escapes the destination: ${linkPath} -> ${linkName}`);
  let current = path.dirname(target);
  let followed = 0;
  function components(value: string): string[] {
    // Do not normalize away '..': the filesystem expands symlinks first.
    const native = process.platform === 'win32' ? value.replaceAll('/', '\\') : value;
    if (path.isAbsolute(native)) {
      if (native !== root && !native.startsWith(`${root}${path.sep}`)) {
        throw escape();
      }
      current = root;
      return native.slice(root.length).split(path.sep);
    }
    if (process.platform === 'win32' && /^[A-Za-z]:/.test(native)) {
      throw escape();
    }
    return native.split(path.sep);
  }
  let pending = components(linkName);
  while (pending.length > 0) {
    const part = pending.shift()!;
    if (part === '' || part === '.') {
      continue;
    }
    if (part === '..') {
      if (current === root) {
        throw escape();
      }
      current = path.dirname(current);
      continue;
    }
    current = path.join(current, part);
    const entry = fs.lstatSync(current, { throwIfNoEntry: false });
    if (entry?.isSymbolicLink()) {
      if (++followed > 40) {
        throw new ArchiveError(`archive symlink chain is cyclic or too deep: ${linkPath}`);
      }
      const next = fs.readlinkSync(current);
      current = path.dirname(current);
      pending = [...components(next), ...pending];
    }
    // Missing components are allowed for forward/dangling links. Recheck all
    // links after extraction, when later entries may have changed resolution.
  }
}

function applyMode(file: string, mode: number): void {
  if (process.platform === 'win32' || mode === 0) {
    return;
  }
  try {
    fs.chmodSync(file, mode);
  } catch {
    // a filesystem without POSIX modes; the file content is what matters
  }
}

function paddedSize(size: number): number {
  return Math.ceil(size / 512) * 512;
}

function readCString(buffer: Buffer, start: number, length: number): string {
  const end = buffer.indexOf(0, start);
  const stop = end === -1 || end > start + length ? start + length : end;
  return buffer.subarray(start, stop).toString('utf8');
}

function readOctal(buffer: Buffer, start: number, length: number): number {
  const text = readCString(buffer, start, length).replace(/[^0-7]/g, '');
  return text === '' ? 0 : Number.parseInt(text, 8);
}

function parsePax(buffer: Buffer): Record<string, string> {
  const attributes: Record<string, string> = {};
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    if (space === -1) {
      break;
    }
    const length = Number.parseInt(buffer.subarray(offset, space).toString('utf8'), 10);
    if (!Number.isFinite(length) || length <= 0 || offset + length > buffer.length) {
      break;
    }
    const record = buffer.subarray(space + 1, offset + length).toString('utf8');
    const separator = record.indexOf('=');
    if (separator > 0) {
      attributes[record.slice(0, separator)] = record.slice(separator + 1).replace(/\n$/, '');
    }
    offset += length;
  }
  return attributes;
}

/** Extracts a gzip-compressed tar archive (ustar, GNU longname and PAX aware). */
export function extractTarGz(archive: string, dest: string): void {
  const buffer = zlib.gunzipSync(fs.readFileSync(archive));
  fs.mkdirSync(dest, { recursive: true });
  const root = fs.realpathSync(dest);
  const symlinks: { name: string; linkName: string; target: string }[] = [];
  let offset = 0;
  let globalPax: Record<string, string> = {};
  let pendingPax: Record<string, string> | null = null;
  let longName: string | null = null;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      break;
    }
    const size = readOctal(header, 124, 12);
    const typeflag = String.fromCharCode(header[156] ?? 0);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > buffer.length) {
      throw new ArchiveError(`truncated tar archive: ${archive}`);
    }
    const prefix = readCString(header, 345, 155);
    let name = readCString(header, 0, 100);
    if (prefix !== '') {
      name = `${prefix}/${name}`;
    }
    let linkName = readCString(header, 157, 100);
    const mode = readOctal(header, 100, 8) & 0o7777;
    const data = buffer.subarray(dataStart, dataEnd);
    if (longName !== null) {
      name = longName;
      longName = null;
    }
    const attributes = { ...globalPax, ...(pendingPax ?? {}) };
    pendingPax = null;
    if (typeof attributes.path === 'string') {
      name = attributes.path;
    }
    if (typeof attributes.linkpath === 'string') {
      linkName = attributes.linkpath;
    }
    offset = dataStart + paddedSize(size);
    if (typeflag === 'g') {
      globalPax = { ...globalPax, ...parsePax(data) };
      continue;
    }
    if (typeflag === 'x') {
      pendingPax = parsePax(data);
      continue;
    }
    if (typeflag === 'L') {
      longName = data.toString('utf8').replace(/\0.*$/s, '');
      continue;
    }
    if (name === '') {
      continue;
    }
    const target = resolveEntry(root, name);
    assertNoSymlinkPath(root, target);
    switch (typeflag) {
      case '0':
      case '\0':
      case '7': {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, data);
        applyMode(target, mode);
        break;
      }
      case '5': {
        fs.mkdirSync(target, { recursive: true });
        applyMode(target, mode);
        break;
      }
      case '2': {
        if (linkName === '') {
          throw new ArchiveError(`archive symlink has no target: ${name}`);
        }
        assertLinkInside(root, name, linkName, target);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.symlinkSync(linkName, target);
        symlinks.push({ name, linkName, target });
        break;
      }
      case '1': {
        if (linkName === '') {
          throw new ArchiveError(`archive hard link has no target: ${name}`);
        }
        const source = resolveEntry(root, linkName);
        assertNoSymlinkPath(root, source);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        try {
          fs.linkSync(source, target);
        } catch {
          fs.copyFileSync(source, target);
        }
        break;
      }
      default:
        // character/block devices, fifos and sockets have no meaning in a tool install
        break;
    }
  }
  for (const { name, linkName, target } of symlinks) {
    assertLinkInside(root, name, linkName, target);
  }
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const minimum = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      return offset;
    }
  }
  throw new ArchiveError('not a zip archive (no end-of-central-directory record)');
}

/** Extracts a zip archive with stored or deflate entries. */
export function extractZip(archive: string, dest: string): void {
  const buffer = fs.readFileSync(archive);
  const eocd = findEndOfCentralDirectory(buffer);
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  fs.mkdirSync(dest, { recursive: true });
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new ArchiveError(`malformed zip central directory in ${archive}`);
    }
    const madeBy = buffer.readUInt16LE(offset + 4);
    const method = buffer.readUInt16LE(offset + 10);
    const crc = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const externalAttributes = buffer.readUInt32LE(offset + 38);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    offset += 46 + nameLength + extraLength + commentLength;
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new ArchiveError(`zip64 archives are not supported: ${name} in ${archive}`);
    }
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new ArchiveError(`malformed zip local header for ${name} in ${archive}`);
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    let data: Buffer;
    if (method === 0) {
      data = Buffer.from(compressed);
    } else if (method === 8) {
      data = zlib.inflateRawSync(compressed);
    } else {
      throw new ArchiveError(`unsupported zip compression method ${method} for ${name} in ${archive}`);
    }
    if (data.length !== uncompressedSize) {
      throw new ArchiveError(`truncated zip entry ${name} in ${archive}`);
    }
    if (zlib.crc32(data) !== crc) {
      throw new ArchiveError(`crc mismatch for ${name} in ${archive}`);
    }
    const target = resolveEntry(dest, name);
    if (name.endsWith('/')) {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    const host = madeBy >> 8;
    if (host === 3) {
      applyMode(target, (externalAttributes >>> 16) & 0o7777);
    }
  }
}
