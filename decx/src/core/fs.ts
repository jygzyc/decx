import * as fs from 'node:fs';
import * as path from 'node:path';

/** scriptc 0.2.7 supports the one-argument lstatSync form only. */
export function lstatIfPresent(file: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return undefined;
  }
}

export function listDirEntries(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

export function walkFiles(root: string): string[] {
  const files: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    for (const entry of listDirEntries(dir)) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        files.push(full);
      }
    }
  }
  return files;
}

export function findFile(root: string, names: readonly string[]): string | null {
  const files = walkFiles(root);
  for (const name of names) {
    const hit = files.find((file) => path.basename(file) === name);
    if (hit !== undefined) {
      return hit;
    }
  }
  return null;
}

export function applyExecutableMode(file: string): void {
  if (process.platform === 'win32') {
    return;
  }
  fs.chmodSync(file, 0o755);
}

export function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
