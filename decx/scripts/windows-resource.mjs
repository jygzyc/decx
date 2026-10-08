import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Embed the UTF-8 process code page before the Windows CRT reads environment strings. */
export function windowsResource(directory, run) {
  const manifest = fileURLToPath(new URL('./native/windows.manifest', import.meta.url)).replaceAll('\\', '/');
  const source = path.join(directory, 'windows.rc');
  const resource = path.join(directory, 'windows.res');
  fs.writeFileSync(source, `1 24 "${manifest}"\n`);
  run('zig', ['rc', '/c65001', '/fo', resource, source]);
  return resource;
}
