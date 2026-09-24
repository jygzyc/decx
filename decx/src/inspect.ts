/**
 * Install inspection.  `decx install` and `decx -m <tool>` never guess: an install
 * exists when `<home>/bin` holds the tool's launcher and the payload directory
 * it points at is there; the version comes from that payload's PROVENANCE.
 */

import fs from 'node:fs';
import path from 'node:path';
import { binRoot, provenanceFile, toolPrefix } from './config.ts';
import type { ToolManifest } from './manifest.ts';
import { exeSuffix } from './platform.ts';

export interface ToolState {
  id: string;
  installed: boolean;
  /** Payload directory (`<home>/share/<id>`). */
  prefix?: string;
  /** The installed launcher inside `<home>/bin`. */
  bin?: string;
  version?: string;
  provenance?: Record<string, string>;
}

/**
 * Parses a PROVENANCE file: `key: value` lines, where indented lines continue
 * the previous value (requirement and binary lists are multi-line).
 */
export function parseProvenance(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  let current: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim() === '') {
      continue;
    }
    if (/^\s/.test(raw) && current !== null) {
      const existing = result[current] ?? '';
      result[current] = existing === '' ? raw.trim() : `${existing}\n${raw.trim()}`;
      continue;
    }
    const separator = raw.indexOf(':');
    if (separator < 0) {
      continue;
    }
    current = raw.slice(0, separator).trim();
    result[current] = raw.slice(separator + 1).trim();
  }
  return result;
}

export function readProvenance(file: string): Record<string, string> | null {
  try {
    return parseProvenance(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Version recorded by the installer, whatever key the install method used. */
export function provenanceVersion(provenance: Record<string, string>): string | undefined {
  for (const key of ['release_tag', 'upstream_tag', 'version']) {
    const value = provenance[key];
    if (value !== undefined && value.trim() !== '' && value.trim() !== 'unknown') {
      return value.trim().replace(/^v/, '');
    }
  }
  return undefined;
}

/** Executable names a PROVENANCE file records, used to create the PATH links. */
export function provenanceBinaries(provenance: Record<string, string>): string[] {
  const list = provenance.binaries;
  if (list !== undefined && list.trim() !== '') {
    return list.split(/\s+/).filter((name) => name !== '');
  }
  const single = provenance.binary;
  if (single !== undefined && single.trim() !== '') {
    return [path.basename(single.trim())];
  }
  return [];
}

function isFile(target: string): boolean {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

function isDir(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function managedLauncher(home: string, bin: string): string | null {
  for (const name of [`${bin}${exeSuffix()}`, `${bin}.cmd`, bin]) {
    const file = path.join(binRoot(home), name);
    if (isFile(file)) {
      return file;
    }
  }
  return null;
}

/**
 * Install state of one tool: the launcher in the store, the payload it belongs
 * to and the PROVENANCE of the last install.  A launcher whose payload is gone
 * is a leftover, not an install.
 */
export function toolState(home: string, manifest: ToolManifest): ToolState {
  const launcher = manifest.launch ?? manifest.bins?.[0] ?? manifest.id;
  const bin = managedLauncher(home, launcher);
  const prefix = toolPrefix(home, manifest.id);
  if (bin === null || !isDir(prefix)) {
    return { id: manifest.id, installed: false, ...(bin !== null ? { bin } : {}) };
  }
  const file = provenanceFile(home, manifest.id);
  const provenance = isFile(file) ? readProvenance(file) : null;
  const version = provenance !== null ? provenanceVersion(provenance) : undefined;
  return {
    id: manifest.id,
    installed: true,
    prefix,
    bin,
    ...(version !== undefined ? { version } : {}),
    ...(provenance !== null ? { provenance } : {}),
  };
}
