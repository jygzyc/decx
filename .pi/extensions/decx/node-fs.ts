import { root, FsSafeError, type Root } from '@openclaw/fs-safe';
import { withFileLock } from '@openclaw/fs-safe/file-lock';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { WikiError, type WikiFs } from './lib.ts';

export interface FsScope {
  /** Existing, trusted directory; never derive this from an operation's input. */
  root: string;
  /** Optional narrower capabilities, relative to root. */
  paths?: readonly string[];
}

export function nodeFs(scopes: () => readonly FsScope[]): WikiFs {
  const handles = new Map<string, Promise<Root>>();
  async function within<T>(path: string, run: (fs: Root, rel: string) => Promise<T>): Promise<T> {
    const absolute = resolve(path);
    const scope = scopes().find(({ root: anchor, paths }) => {
      const rel = relative(resolve(anchor), absolute);
      if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) return false;
      return paths === undefined || paths.some((prefix) => {
        const allowed = prefix.split('/').join(sep);
        return rel === allowed || rel.startsWith(`${allowed}${sep}`);
      });
    });
    if (!scope || path.split(/[\\/]/).includes('..')) {
      throw new WikiError('UNSAFE_PATH', `path is outside the extension's filesystem capabilities: ${path}`);
    }
    const anchor = resolve(scope.root);
    try {
      let handle = handles.get(anchor);
      if (!handle) {
        handle = root(anchor, { symlinks: 'reject', mutationSymlinks: 'reject', hardlinks: 'reject', mkdir: true });
        handles.set(anchor, handle);
        void handle.catch(() => handles.delete(anchor));
      }
      return await run(await handle, relative(anchor, absolute) || '.');
    } catch (error) {
      if (error instanceof FsSafeError && error.code === 'not-found') {
        throw Object.assign(new Error(error.message, { cause: error }), { code: 'ENOENT' });
      }
      if (error instanceof FsSafeError && error.category === 'policy' && error.code !== 'already-exists') {
        throw new WikiError('UNSAFE_PATH', `${error.code}: ${error.message}`);
      }
      throw error;
    }
  }
  return {
    readFile: (path) => within(path, (fs, rel) => fs.readText(rel)),
    async writeFile(path, text) {
      if (/(?:^|[\\/])raw[\\/]traces(?:[\\/]|$)/.test(resolve(path))) {
        throw new WikiError('IMMUTABLE_RAW', 'raw files can only be created once; record a new trace for corrections');
      }
      await within(path, (fs, rel) => fs.write(rel, text));
    },
    async createFile(path, text) {
      try {
        await within(path, (fs, rel) => fs.create(rel, text, { atomic: true }));
        return true;
      } catch (error) {
        if ((error instanceof FsSafeError && error.code === 'already-exists') || (error as NodeJS.ErrnoException).code === 'EEXIST') return false;
        throw error;
      }
    },
    exists: (path) => within(path, (fs, rel) => fs.exists(rel)),
    listDir: (path) => within(path, (fs, rel) => fs.list(rel)),
    mkdirp: (path) => within(path, (fs, rel) => rel === '.' ? Promise.resolve() : fs.mkdir(rel)),
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

/** fs-safe retains lock ownership and does not delete a replacement writer's lock. */
export async function withWorkspaceLock<T>(workspace: string, run: () => Promise<T>): Promise<T> {
  const lock = resolve(workspace, '.pi', 'decx-write.lock');
  try {
    const lockRoot = await root(dirname(resolve(workspace)), {
      symlinks: 'reject', mutationSymlinks: 'reject', hardlinks: 'reject', mkdir: true,
    });
    return await withFileLock(resolve(workspace), {
      lockRoot, lockPath: lock,
      payload: () => ({ pid: process.pid }),
      staleMs: Number.POSITIVE_INFINITY,
      retry: { retries: 0 }, timeoutMs: 0,
      staleRecovery: 'fail-closed', retainOnExit: true,
    }, run);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'file_lock_timeout') {
      throw new WikiError('WORKSPACE_BUSY', `another operation holds ${lock}`,
        'retry after it finishes; after a crash, verify no writer is running before removing this lock file');
    }
    if (error instanceof FsSafeError && error.category === 'policy') {
      throw new WikiError('UNSAFE_PATH', `${error.code}: ${error.message}`);
    }
    throw error;
  }
}
