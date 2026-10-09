import * as fs from 'node:fs';
import * as path from 'node:path';
import { binRoot, resolveLinkDir, runtimePath, toolPrefix } from './config.ts';
import { InstallError } from './install.ts';
import { provenanceBinaries, readProvenance } from './inspect.ts';
import type { ToolManifest } from './manifest.ts';
import { linkFileName, linkName, removeManagedLink } from './links.ts';
import { isWindows } from './platform.ts';

/** Delete only files recorded by this install; never follow links or remove foreign PATH entries. */
export function removeTool(manifest: ToolManifest, home: string, links?: string, env: NodeJS.ProcessEnv = process.env): { id: string; removed: string[] } {
  const prefix = toolPrefix(home, manifest.id);
  const record = readProvenance(path.join(prefix, 'PROVENANCE'));
  if (record === null || record.tool !== manifest.id) {
    throw new InstallError('NOT_INSTALLED', `${manifest.id} is not installed`, { hint: `run \`decx install ${manifest.id}\`` });
  }
  const names = provenanceBinaries(record);
  if (names.some((name) => name !== path.basename(name) || name === '.' || name === '..')) {
    throw new InstallError('INVALID_PROVENANCE', `unsafe executable list for ${manifest.id}`);
  }
  const linkDir = record.link_dir ?? resolveLinkDir(links, env);
  const windows = isWindows();
  const removed: string[] = [];
  for (const name of names) {
    const target = path.join(binRoot(home), name);
    const linked = path.join(linkDir, linkFileName(linkName(name), windows));
    if (removeManagedLink(linkDir, name, target, windows)) removed.push(linked);
    if (fs.existsSync(target)) { fs.unlinkSync(target); removed.push(target); }
  }
  fs.rmSync(prefix, { recursive: true, force: true });
  fs.rmSync(runtimePath(home, manifest.id), { recursive: true, force: true });
  removed.push(prefix);
  return { id: manifest.id, removed };
}
