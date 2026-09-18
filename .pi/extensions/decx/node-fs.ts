import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { WikiFs } from './lib.ts';

/** `WikiFs` backed by the real filesystem; writes create missing directories. */
export function nodeFs(): WikiFs {
  return {
    async readFile(path: string): Promise<string> {
      return readFile(path, 'utf8');
    },
    async writeFile(path: string, text: string): Promise<void> {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, text, 'utf8');
    },
    async exists(path: string): Promise<boolean> {
      try {
        await access(path);
        return true;
      } catch {
        return false;
      }
    },
    async listDir(path: string): Promise<string[]> {
      return readdir(path);
    },
    async mkdirp(path: string): Promise<void> {
      await mkdir(path, { recursive: true });
    },
  };
}
