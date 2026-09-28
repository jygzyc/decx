/**
 * Workspace paths and boundary checks for the Decx knowledge layers.
 * Shared by the extension, CLI and tests through `./lib.ts`.
 */

import { WikiError } from './errors.ts';

export const FILES = {
  index: 'index.md',
  logs: 'logs.md',
  impact: 'skill-impact.md',
  patterns: 'patterns',
} as const;

export const LAYERS = {
  raw: 'raw',
  wiki: 'wiki',
  skills: 'skills',
} as const;

export const RAW_TRACES = 'traces';
export const LOCAL_WIKI = '.decxwiki';

export const INDEX_START = '<!-- decx:index:start -->';
export const INDEX_END = '<!-- decx:index:end -->';
export const INDEX_ROW = /^- `([^`]+)` — (.*)$/;
export const PATTERN_SECTIONS = ['Match', 'Non-obvious', 'Reject'];
export const PATTERN_NAME = /^[a-z0-9][a-z0-9_-]*$/;
export const PROPOSAL_STATUS = ['proposed', 'accepted', 'rejected'] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUS)[number];

export interface Workspace {
  name: string;
  root: string;
  wiki: string;
  raw: string;
  skills: string;
}

export function joinPath(...parts: string[]): string {
  return parts
    .filter((part) => part !== '')
    .join('/')
    .replaceAll(/\/{2,}/g, '/');
}

/** Rejects anything that is not a plain relative path inside the workspace. */
export function normalizeRel(rel: string): string {
  const cleaned = rel.trim().replaceAll('\\', '/').replace(/^\.\//, '');
  if (cleaned === '' || cleaned.startsWith('/') || /^[a-zA-Z]:/.test(cleaned)) {
    throw new WikiError(
      'BAD_PATH',
      `"${rel}" is not a path inside the workspace`,
      'paths are relative, e.g. "patterns/android-app-exported_access.md"',
    );
  }

  const parts = cleaned.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.includes('..')) {
    throw new WikiError(
      'BAD_PATH',
      `"${rel}" escapes the workspace`,
      'paths are relative, e.g. "patterns/do_something.md"',
    );
  }

  return parts.join('/');
}
