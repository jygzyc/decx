/**
 * Install inspection.  `decx install` and `decx -m <tool>` never guess: an install
 * exists when `<home>/bin` holds the tool's launcher and the payload directory
 * it points at is there; the version comes from that payload's PROVENANCE.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { binRoot, provenanceFile, toolPrefix } from './config.ts';
import type { ToolManifest } from './manifest.ts';

export interface ToolState {
  id: string;
  installed: boolean;
  /** Payload directory (`<home>/share/<id>`). */
  prefix?: string;
  /** The installed launcher inside `<home>/bin`. */
  bin?: string;
  version?: string | undefined;
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
  return provenance.version?.trim() || undefined;
}

/** Executable names a PROVENANCE file records, used to create the PATH links. */
export function provenanceBinaries(provenance: Record<string, string>): string[] {
  return (provenance.binaries ?? '').split(/\s+/).filter(Boolean);
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

/**
 * Install state of one tool: the launcher in the store, the payload it belongs
 * to and the PROVENANCE of the last install.  A launcher whose payload is gone
 * is a leftover, not an install.
 */
export function toolState(home: string, manifest: ToolManifest): ToolState {
  const prefix = toolPrefix(home, manifest.id);
  const provenance = readProvenance(provenanceFile(home, manifest.id));
  const bin = provenance?.binary;
  if (provenance?.tool !== manifest.id || bin === undefined || path.dirname(bin) !== binRoot(home) ||
    !provenanceBinaries(provenance).includes(path.basename(bin)) || !isFile(bin) || !isDir(prefix)) {
    return { id: manifest.id, installed: false };
  }
  return { id: manifest.id, installed: true, prefix, bin, version: provenanceVersion(provenance), provenance };
}
