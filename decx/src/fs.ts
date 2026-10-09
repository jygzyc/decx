import * as fs from 'node:fs';

/** scriptc 0.2.7 supports the one-argument lstatSync form only. */
export function lstatIfPresent(file: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return undefined;
  }
}
