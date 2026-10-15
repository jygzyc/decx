import * as fs from 'node:fs';
import * as path from 'node:path';

export function lstatIfPresent(file: string): fs.Stats | undefined {
  return fs.lstatSync(file, { throwIfNoEntry: false });
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

/** Index one traversal, retaining the first match for duplicate basenames. */
export function indexFiles(root: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const file of walkFiles(root)) {
    const name = path.basename(file);
    if (!files.has(name)) files.set(name, file);
  }
  return files;
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
