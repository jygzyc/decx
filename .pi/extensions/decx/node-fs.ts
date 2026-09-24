import { access, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, parse, resolve, sep } from 'node:path';
import { WikiError, type WikiFs } from './lib.ts';

/** Managed layers cannot contain symlinks or hard-linked files. Ancestors such
 * as macOS /tmp may be aliases; layer directories themselves may not. This is
 * an API boundary, not protection against a hostile concurrent local process. */
async function guard(path: string): Promise<void> {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const parts = absolute.slice(root.length).split(sep);
  let managed = false;
  let current = root;
  for (const part of parts) {
    current = resolve(current, part);
    managed ||= ['raw', 'wiki', 'skills'].includes(part);
    if (!managed) continue;
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1)) {
        throw new WikiError('UNSAFE_PATH', `managed path is a link: ${current}`);
      }
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
  }
}

export function nodeFs(): WikiFs {
  return {
    async readFile(path) {
      await guard(path);
      return readFile(path, 'utf8');
    },
    async writeFile(path, text) {
      if (resolve(path).split(sep).includes('raw')) throw new WikiError('IMMUTABLE_RAW', 'raw files can only be created once; record a new trace for corrections');
      await guard(path);
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, text, { encoding: 'utf8', flag: 'wx' });
        await rename(temporary, path);
      } finally {
        await rm(temporary, { force: true });
      }
    },
    async createFile(path, text) {
      await guard(path);
      await mkdir(dirname(path), { recursive: true });
      try {
        await writeFile(path, text, { encoding: 'utf8', flag: 'wx' });
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
        throw error;
      }
    },
    async exists(path) {
      await guard(path);
      try { await access(path); return true; }
      catch (error) {
        if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
        throw error;
      }
    },
    async listDir(path) { await guard(path); return readdir(path); },
    async mkdirp(path) { await guard(path); await mkdir(path, { recursive: true }); },
  };
}

/** Serialize full read/modify/write operations, not just the final write. */
export function operationQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(run: () => Promise<T>): Promise<T> => {
    const next = tail.then(run);
    tail = next.catch(() => undefined);
    return next;
  };
}

/** All cooperating pi sessions and the CLI use the same workspace lock. */
export async function withWorkspaceLock<T>(root: string, run: () => Promise<T>): Promise<T> {
  const lock = resolve(root, '.pi', 'decx-write.lock');
  await mkdir(dirname(lock), { recursive: true });
  try { await mkdir(lock); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new WikiError('WORKSPACE_BUSY', `another operation holds ${lock}`, 'retry after it finishes; after a crash, verify no writer is running before removing this lock directory');
    }
    throw error;
  }
  try { return await run(); }
  finally { await rm(lock, { recursive: true }); }
}
