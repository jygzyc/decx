/**
 * DECX_HOME layout.
 *
 *   <home>/bin/<name>       the installed executables and the launchers that
 *                           wrap them, one file per command
 *   <home>/runtime/<id>/    per-tool runtime environments (e.g. Python venv)
 *   <home>/share/<id>/      per-tool payload: PROVENANCE, specs, archive payload
 *   <links>/<name>          PATH entry: a symlink to `<home>/bin/<name>` (a
 *                           generated `.cmd` shim on Windows)
 *
 * `<links>` defaults to `~/.local/bin` and can be overridden with `--links` or
 * `$DECX_LINKS_DIR`.
 */

import * as os from 'node:os';
import * as path from 'node:path';

export const ENV_HOME = 'DECX_HOME';
export const ENV_LINKS = 'DECX_LINKS_DIR';

/** `<home>/bin` -- executables of every installed tool (the store). */
export function binRoot(home: string): string {
  return path.join(home, 'bin');
}

/** `<home>/runtime/<id>` -- private interpreter environment for a tool. */
export function runtimePath(home: string, id: string): string {
  return path.join(home, 'runtime', id);
}

/** `<home>/share` -- per-tool payloads. */
export function shareRoot(home: string): string {
  return path.join(home, 'share');
}

/** Payload prefix of a tool: `<home>/share/<id>`. */
export function toolPrefix(home: string, id: string): string {
  return path.join(shareRoot(home), id);
}

/** The record every install writes next to its payload. */
export function provenanceFile(home: string, id: string): string {
  return path.join(toolPrefix(home, id), 'PROVENANCE');
}

/**
 * Resolves DECX_HOME: an explicit `--home` wins over `$DECX_HOME`, which wins
 * over `~/.decx`.  The result is always absolute.
 */
export function resolveHome(flag?: string, env: NodeJS.ProcessEnv = process.env): string {
  const explicit = flag !== undefined && flag.trim() !== '' ? flag : env[ENV_HOME];
  const chosen = explicit !== undefined && explicit.trim() !== '' ? explicit : path.join(userHome(env), '.decx');
  return path.resolve(chosen);
}

/** `$HOME`, `%USERPROFILE%`, else the OS account directory (keeps tests hermetic). */
export function userHome(env: NodeJS.ProcessEnv): string {
  const home = env.HOME ?? env.USERPROFILE;
  return home !== undefined && home.trim() !== '' ? home : os.homedir();
}

/**
 * Resolves the link directory: an explicit `--links` wins over
 * `$DECX_LINKS_DIR`, which wins over `~/.local/bin`.  The result is absolute.
 */
export function resolveLinkDir(flag?: string, env: NodeJS.ProcessEnv = process.env): string {
  const explicit = flag !== undefined && flag.trim() !== '' ? flag : env[ENV_LINKS];
  const chosen = explicit !== undefined && explicit.trim() !== '' ? explicit : path.join(userHome(env), '.local', 'bin');
  return path.resolve(chosen);
}
