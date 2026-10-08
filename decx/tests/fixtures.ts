/**
 * Offline test fixtures: tar.gz and zip builders (node:zlib only) plus a local
 * HTTP server the installer can download from.  Only `*.test.ts` files are run
 * by `node --test`, so this helper never executes on its own.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync, gzipSync, crc32 } from 'node:zlib';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

export const SUBPROJECTS_DIR = fileURLToPath(new URL('../../subprojects', import.meta.url));

export function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function writeFile(file: string, data: string | Buffer, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  if (mode !== undefined && process.platform !== 'win32') {
    fs.chmodSync(file, mode);
  }
}

export interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
  json: unknown;
}

/** Runs the real CLI in a child Node process with a merged environment. */
export function runCli(args: readonly string[], env: NodeJS.ProcessEnv = {}): CliResult {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  let json: unknown;
  try {
    json = JSON.parse(result.stdout) as unknown;
  } catch {
    json = undefined;
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, json };
}

export interface TarEntry {
  name: string;
  data?: string | Buffer;
  mode?: number;
  type?: 'file' | 'dir' | 'symlink';
  link?: string;
  /** Write the real name in a PAX `path=` record and a short header name. */
  paxPath?: string;
}

function padded(size: number): number {
  return Math.ceil(size / 512) * 512;
}

function octal(value: number, length: number): string {
  return `${value.toString(8).padStart(length - 1, '0')}\0`;
}

function tarHeader(name: string, size: number, mode: number, typeflag: string, linkname: string): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write(octal(mode & 0o7777, 8), 100, 8, 'utf8');
  header.write(octal(0, 8), 108, 8, 'utf8');
  header.write(octal(0, 8), 116, 8, 'utf8');
  header.write(octal(size, 12), 124, 12, 'utf8');
  header.write(octal(0, 12), 136, 12, 'utf8');
  header.write('        ', 148, 8, 'utf8');
  header.write(typeflag, 156, 1, 'utf8');
  header.write(linkname, 157, 100, 'utf8');
  header.write('ustar\0', 257, 6, 'utf8');
  header.write('00', 263, 2, 'utf8');
  let checksum = 0;
  for (const byte of header) {
    checksum += byte;
  }
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'utf8');
  return header;
}

function paxRecord(key: string, value: string): string {
  const body = `${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 1;
  for (;;) {
    const candidate = `${length} ${body}`;
    const size = Buffer.byteLength(candidate);
    if (size === length) {
      return candidate;
    }
    length = size;
  }
}

/** Builds a gzip-compressed tar archive with ustar headers. */
export function makeTarGz(entries: readonly TarEntry[]): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const type = entry.type ?? 'file';
    const data = type === 'file' && entry.data !== undefined ? Buffer.from(entry.data) : Buffer.alloc(0);
    if (entry.paxPath !== undefined) {
      const record = Buffer.from(paxRecord('path', entry.paxPath), 'utf8');
      chunks.push(tarHeader(`PaxHeaders/${entry.name.slice(0, 60)}`, record.length, 0o644, 'x', ''), record);
      chunks.push(Buffer.alloc(padded(record.length) - record.length));
    }
    const typeflag = type === 'dir' ? '5' : type === 'symlink' ? '2' : '0';
    const mode = entry.mode ?? (type === 'dir' ? 0o755 : 0o644);
    chunks.push(tarHeader(entry.name, data.length, mode, typeflag, entry.link ?? ''));
    if (data.length > 0) {
      chunks.push(data, Buffer.alloc(padded(data.length) - data.length));
    }
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks));
}

export interface ZipEntry {
  name: string;
  data?: string | Buffer;
  mode?: number;
  /** Store the entry instead of deflating it (to cover both methods). */
  stored?: boolean;
}

/** Builds a zip archive by hand: local headers, central directory, EOCD. */
export function makeZip(entries: readonly ZipEntry[]): Buffer {
  const localChunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.from(entry.data ?? '');
    const isDir = entry.name.endsWith('/');
    const stored = entry.stored === true || raw.length === 0;
    const compressed = stored ? raw : deflateRawSync(raw);
    const method = stored ? 0 : 8;
    const crc = crc32(raw) >>> 0;
    const mode = entry.mode ?? (isDir ? 0o755 : 0o644);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((isDir ? 0o040000 | mode : mode) << 16, 38);
    central.writeUInt32LE(localOffset, 42);
    localChunks.push(local, name, compressed);
    centralChunks.push(central, name);
    localOffset += local.length + name.length + compressed.length;
  }
  const centralSize = centralChunks.reduce((total, chunk) => total + chunk.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localChunks, ...centralChunks, eocd]);
}

export interface FixtureServer {
  url: string;
  requested: string[];
  authorizations: Array<string | undefined>;
  close(): Promise<void>;
}

/** Serves fixed files by pathname; unknown paths answer 404. */
export async function startFixtureServer(
  routes: Record<string, Buffer | string>,
  statuses: Record<string, number> = {},
  headers: Record<string, Record<string, string>> = {},
): Promise<FixtureServer> {
  const requested: string[] = [];
  const authorizations: Array<string | undefined> = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    requested.push(url.pathname);
    authorizations.push(request.headers.authorization);
    const body = routes[url.pathname];
    if (body === undefined) {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('not found');
      return;
    }
    response.writeHead(statuses[url.pathname] ?? 200, {
      'content-type': url.pathname.endsWith('.json') ? 'application/json' : 'application/octet-stream',
      ...headers[url.pathname],
    });
    response.end(body);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('fixture server did not bind a TCP port');
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    requested,
    authorizations,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error !== undefined && error !== null) {
            reject(error);
          } else {
            resolve();
          }
        });
      }),
  };
}
