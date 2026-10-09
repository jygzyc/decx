import * as fs from 'node:fs';

/** Like lstatSync(..., { throwIfNoEntry: false }), without the options overload. */
export function lstatIfPresent(file: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return undefined;
  }
}
