import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LoadResult } from './catalog/manifest.ts';

/** esbuild defines these; native builds generate this metadata module instead. */
declare const __DECX_VERSION__: string;
declare const __DECX_MANIFESTS__: LoadResult;
export const embeddedManifests: LoadResult | undefined = typeof __DECX_MANIFESTS__ !== 'undefined' ? __DECX_MANIFESTS__ : undefined;
export const runtimeInfo = { node: process.versions.node };

export function packageVersion(): string {
  if (typeof __DECX_VERSION__ !== 'undefined') return __DECX_VERSION__;
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const parsed = JSON.parse(fs.readFileSync(path.resolve(here, '..', 'package.json'), 'utf8')) as { version?: string };
    return parsed.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
