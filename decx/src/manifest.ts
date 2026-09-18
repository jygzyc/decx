/**
 * Tool manifests.  One JSON file per tool under `subprojects/decx-<id>/decx-<id>.json`
 * describes where the tool comes from, how it is installed and how it is
 * launched.  A manifest is data only: the CLI never grows per-tool code.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { PlatformKey } from './platform.ts';

export type ToolKind = 'binary' | 'python-venv';

export interface LaunchSpec {
  /** Launcher name inside the install's `bin/` (`.exe`/`.cmd` handled by the installer). */
  bin: string;
  /** Arguments an agent can pass through, for documentation only. */
  args?: string[];
}

/** Single-archive release source, e.g. an upstream GitHub release. */
export interface ReleaseSpec {
  /** `owner/repo` on GitHub. */
  repository: string;
  /** Version this repository was verified against; releases newer than this still install. */
  version?: string;
  /** Exact release tag when it differs from the tool version (requires `version`). */
  tag?: string;
  /** Tag prefix, e.g. `tools-v` when the release tag is `tools-v1.2.3`. */
  tagPrefix?: string;
  /** Platform key (or `any`) -> asset file name (`{version}` is substituted). */
  assets: Record<string, string>;
  /** Extra assets that belong to every platform, e.g. Kuna's compiled specs. */
  extraAssets?: Record<string, string>;
  /** Checksum asset carrying `sha256  filename` lines, when upstream publishes one. */
  checksums?: string;
  /** Build the source checkout when no release can be resolved (needs `source.build`). */
  allowSourceFallback?: boolean;
}

/** Build from a vendored checkout when no prebuilt artifact is usable. */
export interface SourceSpec {
  /** Directory inside this repository, e.g. `subprojects/decx-kuna`. */
  path: string;
  build?: {
    /** Cargo manifest, relative to `path`. */
    manifest: string;
    /** Packages to build; the binaries are taken from `target/release`. */
    packages: string[];
    /**
     * Environment variables for the build; `{version}` becomes the version the
     * manifest pins (or the checkout tag).  Upstream release CI bakes its
     * version into the binaries this way (Kuna: `KUNA_VERSION`).
     */
    env?: Record<string, string>;
  };
  specs?: {
    /** Vendored SLEIGH specs, relative to `path`. */
    path: string;
    /** Binary that compiles them. */
    compiler: string;
  };
}

/** Pinned upstream GitHub source archive, downloaded without a git checkout. */
export interface PythonArchiveSpec {
  repository: string;
  /** Commit or tag passed to GitHub's `/archive/<ref>.tar.gz` endpoint. */
  ref: string;
  /** Expected SHA-256; a mismatch is fatal and never triggers a fallback. */
  sha256?: string;
}

/** `kind: "python-venv"` tools: upstream sources plus a private virtualenv. */
export interface PythonSpec {
  /** Legacy local checkout, used only when `archive` is absent. */
  path?: string;
  /** Preferred upstream source; the archive may be flat or have one root directory. */
  archive?: PythonArchiveSpec;
  /** Entry point started by the launcher. */
  entry: string;
  /** Requirements file installed into the virtualenv. */
  requirements: string;
  /** Source directories copied into the payload. */
  payload: string[];
}

export interface ToolManifest {
  manifest: 1;
  id: string;
  kind: ToolKind;
  summary: string;
  homepage?: string;
  license?: string;
  /** Free-form caveat shown by `list`. */
  notes?: string;
  /** Runtime requirements, enforced by `install` before it stages anything. */
  requires?: { node?: string; python?: string; rust?: string };
  /**
   * Environment the tool's launchers export before running the packaged binary,
   * e.g. where a release payload keeps data the tool has to find by itself.
   * `{prefix}` is the payload directory, `{version}` the installed version; a
   * manifest that declares any gets launcher wrappers in `<home>/bin`.
   */
  env?: Record<string, string>;
  launch?: LaunchSpec;
  /** Binaries the install must produce (binary tools). */
  bins?: string[];
  /** Command an agent can pass arguments to, for documentation only. */
  release?: ReleaseSpec;
  /** Mirror release tried only when the primary source is unavailable, never on failed checks. */
  fallbackRelease?: ReleaseSpec;
  source?: SourceSpec;
  python?: PythonSpec;
  /** Command used to verify a fresh install, e.g. `--version`. */
  verify?: { args: string[] };
}

export interface ManifestIssue {
  file: string;
  message: string;
}

export interface LoadResult {
  tools: ToolManifest[];
  issues: ManifestIssue[];
}

const KINDS: ToolKind[] = ['binary', 'python-venv'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `NAME=value` maps whose values are non-empty strings, e.g. `env` and `build.env`. */
function isEnvRecord(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.entries(value).every(([name, item]) => name.trim() !== '' && typeof item === 'string' && item.trim() !== '')
  );
}

function requireString(record: Record<string, unknown>, key: string, where: string, errors: string[]): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim() === '') {
    errors.push(`${where}: missing required string "${key}"`);
    return '';
  }
  return value;
}

function validateRelease(value: unknown, where: string, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${where} must be an object`);
    return;
  }
  if (typeof value.repository !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(value.repository)) {
    errors.push(`${where}.repository must be "owner/repo"`);
  }
  if (!isEnvRecord(value.assets) || Object.keys(value.assets).length === 0) {
    errors.push(`${where}.assets must map platform keys to asset names`);
  }
  if (value.extraAssets !== undefined && !isEnvRecord(value.extraAssets)) {
    errors.push(`${where}.extraAssets must map names to asset names`);
  }
  for (const key of ['version', 'tag', 'tagPrefix', 'checksums']) {
    if (value[key] !== undefined) {
      requireString(value, key, where, errors);
    }
  }
  if (value.tag !== undefined && value.version === undefined) {
    errors.push(`${where}.tag requires a tool version`);
  }
  if (value.allowSourceFallback !== undefined && typeof value.allowSourceFallback !== 'boolean') {
    errors.push(`${where}.allowSourceFallback must be a boolean`);
  }
}

/** Validates one manifest object, returning every problem found. */
export function validateManifest(value: unknown, file = 'manifest'): { manifest?: ToolManifest; errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return { errors: [`${file}: not a JSON object`] };
  }
  if (value.manifest !== 1) {
    errors.push(`${file}: unsupported "manifest" version (expected 1)`);
  }
  const id = requireString(value, 'id', file, errors);
  const summary = requireString(value, 'summary', file, errors);
  const kind = value.kind;
  if (typeof kind !== 'string' || !(KINDS as string[]).includes(kind)) {
    errors.push(`${file}: "kind" must be one of ${KINDS.join(', ')}`);
  }
  const manifest = value as unknown as ToolManifest;
  if (kind === 'binary' && !isRecord(value.release) && !isRecord(value.source)) {
    errors.push(`${file}: kind "binary" needs a "release" or "source" block`);
  }
  if (kind === 'python-venv' && !isRecord(value.python)) {
    errors.push(`${file}: kind "python-venv" needs a "python" block`);
  }
  if (value.release !== undefined) {
    validateRelease(value.release, `${file}: release`, errors);
  }
  if (value.fallbackRelease !== undefined) {
    validateRelease(value.fallbackRelease, `${file}: fallbackRelease`, errors);
    if (isRecord(value.fallbackRelease)) {
      requireString(value.fallbackRelease, 'version', `${file}: fallbackRelease`, errors);
    }
    if (kind === 'binary' && !isRecord(value.release)) {
      errors.push(`${file}: binary fallbackRelease needs a primary release`);
    }
  }
  if (isRecord(value.python)) {
    const python = value.python;
    if (python.path === undefined && python.archive === undefined) {
      errors.push(`${file}: python needs a path or archive`);
    }
    if (python.path !== undefined) {
      requireString(python, 'path', `${file}: python`, errors);
    }
    for (const key of ['entry', 'requirements']) {
      requireString(python, key, `${file}: python`, errors);
    }
    if (!Array.isArray(python.payload) || python.payload.some((item) => typeof item !== 'string' || item.trim() === '')) {
      errors.push(`${file}: python.payload must be a list of non-empty strings`);
    }
    if (python.archive !== undefined) {
      if (!isRecord(python.archive)) {
        errors.push(`${file}: python.archive must be an object`);
      } else {
        const archive = python.archive;
        if (typeof archive.repository !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(archive.repository)) {
          errors.push(`${file}: python.archive.repository must be "owner/repo"`);
        }
        requireString(archive, 'ref', `${file}: python.archive`, errors);
        if (archive.sha256 !== undefined && (typeof archive.sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(archive.sha256))) {
          errors.push(`${file}: python.archive.sha256 must be a SHA-256 hex digest`);
        }
      }
    }
  }
  if (value.bins !== undefined) {
    if (!Array.isArray(value.bins) || value.bins.some((bin) => typeof bin !== 'string' || bin.trim() === '')) {
      errors.push(`${file}: bins must be a list of non-empty strings`);
    }
  }
  if (kind === 'binary' && !Array.isArray(value.bins)) {
    errors.push(`${file}: kind "binary" needs a "bins" list naming the executables it installs`);
  }
  if (value.env !== undefined && !isEnvRecord(value.env)) {
    errors.push(`${file}: env must map variable names to non-empty strings`);
  }
  if (value.env !== undefined && kind === 'python-venv') {
    errors.push(`${file}: env is only supported for kind "binary" (the venv launcher is generated)`);
  }
  if (isRecord(value.source)) {
    const source = value.source as Record<string, unknown>;
    const build = isRecord(source.build) ? (source.build as Record<string, unknown>) : undefined;
    if (build?.env !== undefined && !isEnvRecord(build.env)) {
      errors.push(`${file}: source.build.env must map variable names to non-empty strings`);
    }
  }
  if (typeof value.launch === 'object' && value.launch !== null) {
    const launch = value.launch as Record<string, unknown>;
    if (typeof launch.bin !== 'string' || launch.bin.trim() === '') {
      errors.push(`${file}: launch.bin must be a non-empty string`);
    }
  }
  if (errors.length > 0) {
    return { errors };
  }
  return { manifest: { ...manifest, id, summary }, errors: [] };
}

/** A tool subproject directory names its tool id: `decx-<id>` (or plain `<id>`). */
function toolIdFromName(name: string): string {
  return name.startsWith('decx-') ? name.slice('decx-'.length) : name;
}

/** `decx-*.json` files sitting in a directory where one manifest was expected. */
function manifestNamesIn(subprojectDir: string): string[] {
  try {
    return fs
      .readdirSync(subprojectDir)
      .filter((entry) => entry.startsWith('decx-') && entry.endsWith('.json'))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Loads every tool manifest under `dir`: each subproject directory holds
 * `decx-<id>.json` for the id it is named after — `subprojects/decx-<id>/…`,
 * or `<id>/…` for a plain directory.  Unreadable or invalid manifests are
 * reported as issues instead of failing the whole command, so a broken tool
 * never blocks the others.
 */
export function loadManifests(dir: string): LoadResult {
  const tools: ToolManifest[] = [];
  const issues: ManifestIssue[] = [];
  if (!fs.existsSync(dir)) {
    return { tools, issues: [{ file: dir, message: 'tool manifest directory not found' }] };
  }
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const name of entries) {
    const id = toolIdFromName(name);
    const file = path.join(dir, name, `decx-${id}.json`);
    if (!fs.existsSync(file)) {
      const strays = manifestNamesIn(path.join(dir, name));
      if (strays.length > 0) {
        issues.push({ file, message: `found ${strays.join(', ')}, expected decx-${id}.json` });
      } else if (id !== name) {
        issues.push({ file, message: `no decx-${id}.json in subprojects/${name}` });
      }
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      issues.push({ file, message: `invalid JSON: ${(error as Error).message}` });
      continue;
    }
    const { manifest, errors } = validateManifest(parsed, file);
    if (manifest === undefined) {
      for (const message of errors) {
        issues.push({ file, message });
      }
      continue;
    }
    if (manifest.id !== id) {
      issues.push({ file, message: `manifest id "${manifest.id}" does not match directory "${name}"` });
      continue;
    }
    tools.push(manifest);
  }
  return { tools, issues };
}

/** Platform keys a manifest can install on, `['any']` when it is source-only. */
export function supportedPlatforms(manifest: ToolManifest): string[] {
  if (manifest.kind === 'python-venv') {
    return ['any'];
  }
  const keys = [...new Set([...Object.keys(manifest.release?.assets ?? {}), ...Object.keys(manifest.fallbackRelease?.assets ?? {})])].sort();
  if (keys.length > 0) {
    return keys;
  }
  return manifest.source !== undefined || manifest.python !== undefined ? ['any'] : [];
}

/** The release asset for one platform, or null when the platform is unsupported. */
export function releaseAssetFor(manifest: ToolManifest, platform: PlatformKey): string | null {
  const asset = manifest.release?.assets[platform] ?? manifest.release?.assets.any;
  if (asset === undefined) {
    return null;
  }
  return asset.replaceAll('{version}', manifest.release?.version ?? '{version}');
}
