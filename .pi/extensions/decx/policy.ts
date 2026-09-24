import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { Workspace } from './lib.ts';

export type Phase = 'inference' | 'maintain' | 'propose';
export const PHASES: Phase[] = ['inference', 'maintain', 'propose'];
const tools: Record<Phase, string[]> = {
  inference: ['decx_trace', 'decx_checkpoint'],
  maintain: ['decx_read', 'decx_maintain', 'decx_check', 'decx_checkpoint'],
  propose: ['decx_read', 'decx_propose', 'decx_gate', 'decx_check', 'decx_checkpoint'],
};

function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

/** Resolve existing ancestors too, so writes through directory aliases are checked. */
async function canonical(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = dirname(path);
    if (parent === path) return path;
    return resolve(await canonical(parent), relative(parent, path));
  }
}

export async function toolBlock(phase: Phase, name: string, input: Record<string, unknown>, cwd: string, workspaces: Workspace[]): Promise<string | undefined> {
  if (workspaces.length === 0) return;
  if (name.startsWith('decx_')) return tools[phase].includes(name) ? undefined : `Decx ${phase}: ${name} is unavailable; the user can select /decx phase maintain|propose in a separate maintenance session.`;
  // Maintenance has no general execution tools: writes go through validated APIs.
  if (phase !== 'inference') return 'Decx maintenance permits only its structured tools; use decx_read, decx_maintain, decx_propose or decx_gate.';
  if (name === 'bash' || name === 'powershell') {
    // Advisory interception of explicit references only. Shells are not a sandbox.
    if (/(?:\b(?:raw|wiki)\b|PURPOSE\.md)/i.test(String(input.command ?? ''))) return 'Decx inference cannot access raw/wiki or PURPOSE.md through shell commands.';
    return;
  }
  if (!['read', 'write', 'edit', 'grep', 'find', 'ls'].includes(name)) return;
  const path = resolve(cwd, typeof input.path === 'string' ? input.path : '.');
  const resolved = await canonical(path);
  const mutation = name === 'write' || name === 'edit';
  const recursive = ['grep', 'find'].includes(name);
  for (const ws of workspaces) {
    for (const layer of [ws.wiki, ws.raw, ...(mutation ? [ws.skills] : [])]) {
      const realLayer = await canonical(resolve(layer));
      if ([path, resolved].some(p => inside(resolve(layer), p) || inside(realLayer, p) || ((mutation || recursive) && (inside(p, resolve(layer)) || inside(p, realLayer))))) {
        return 'Decx protects this knowledge layer; inference reads skills only, raw is append-only via decx_trace, and wiki writes require maintenance tools.';
      }
    }
  }
  if (recursive) {
    for (const ws of workspaces) {
      const skillRoot = await canonical(resolve(ws.skills));
      const rel = relative(skillRoot, resolved).split(sep);
      if (inside(skillRoot, resolved) && rel.length <= 1) return 'Scope skill searches to references/ to exclude maintenance metadata.';
    }
  }
  if (!mutation && /(?:^|[/\\])PURPOSE\.md$/i.test(resolved)) return 'PURPOSE.md is maintenance metadata, not inference context.';
  if (!mutation) {
    try {
      const stat = await lstat(resolved);
      if (stat.isFile() && stat.nlink > 1) return 'Decx cannot establish the source of a hard-linked file.';
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
