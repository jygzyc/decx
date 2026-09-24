/**
 * Tool manifests.  One JSON file per tool under `subprojects/decx-<id>/decx-<id>.json`
 * describes where the tool comes from, how it is installed and how it is
 * launched.  A manifest is data only: the CLI never grows per-tool code.
 *
 * Most of the recipe is convention, so a manifest states only what deviates.
 * Defaults, applied when the file loads:
 *   id              the subproject directory (`decx-<id>`)
 *   kind            `python-venv` when a `python` block is present, else `binary`
 *   release.repository  jygzyc/decx (every tool releases into this repository)
 *   release.tagPrefix   `<id>-v`    (releases are tagged `<id>-v<version>`)
 *   release.checksums   `<id>-SHA256SUMS.txt`
 *   python.payload      `[<id>]`
 *   launch          the first `bins` entry, or `<id>` for venv tools
 *
 * `release.asset` names the per-platform asset once — `{os}`/`{arch}` are the
 * host's axes (`win`/`darwin`/`linux`, `arm64`/`amd64`), `{version}` the version
 * resolved from the tag.
 * `release.assets` maps platform keys explicitly (or to `any` for a platform-
 * independent payload) when a tool's names deviate.  The `release` block is
 * otherwise the whole story of a version: GitHub Actions publishes one release
 * per tool version, and the CLI downloads the asset that belongs to the host.
 * How an asset is produced (upstream release, mirror, compiled specs) is the
 * release workflow's business, not the manifest's.
 */

import fs from 'node:fs';
import path from 'node:path';
import { SUPPORTED_PLATFORMS, type PlatformKey } from './platform.ts';

export type ToolKind = 'binary' | 'python-venv';

/** Where every tool's releases live unless a manifest points elsewhere. */
export const DEFAULT_RELEASE_REPOSITORY = 'jygzyc/decx';

/** The tool's release; one release per version, assets named per platform. */
export interface ReleaseSpec {
  /** `owner/repo` on GitHub; `jygzyc/decx` unless a manifest overrides it. */
  repository: string;
  /**
   * Tag prefix of this tool's releases, e.g. `kuna-v` when versions are tagged
   * `kuna-v1.544`.  `decx install <id>` installs the newest matching release;
   * `--version <tag|version>` picks one explicitly.
   */
  tagPrefix: string;
  /**
   * Asset template naming the payload for every platform: `{os}` and `{arch}`
   * are the host's operating system (`win`, `darwin`, `linux`) and architecture
   * (`arm64`, `amd64`), `{version}` the version.  A template without `{os}` and
   * `{arch}` names one platform-independent payload (a source archive).
   * Exactly one of `asset` and `assets`.
   */
  asset?: string;
  /** Platform key (or `any`) -> asset file name, for tools whose names deviate. */
  assets?: Record<string, string>;
  /** Extra assets that belong to every platform, e.g. Kuna's compiled specs. */
  extraAssets?: Record<string, string>;
  /** Checksum asset carrying `sha256  filename` lines; `<id>-SHA256SUMS.txt` by default. */
  checksums: string;
}

/** `kind: "python-venv"` tools: the release's source payload plus a private virtualenv. */
export interface PythonSpec {
  /** Entry point started by the launcher. */
  entry: string;
  /** Requirements file installed into the virtualenv. */
  requirements: string;
  /** Source directories copied into the payload; `[<id>]` by default. */
  payload: string[];
  /**
   * Directory the environment is created in, inside the payload; `.venv` by
   * default. A bare directory name: an install always creates it fresh and
   * refuses to reuse an environment it finds there.
   */
  venv: string;
}

export interface ToolManifest {
  manifest: 2;
  id: string;
  kind: ToolKind;
  summary: string;
  homepage?: string;
  license?: string;
  /** Free-form caveat shown by `list`. */
  notes?: string;
  /** Runtime requirements, enforced by `install` before it stages anything. */
  requires?: { python?: string };
  /**
   * Environment the tool's launchers export before running the packaged binary,
   * e.g. where a release payload keeps data the tool has to find by itself.
   * `{prefix}` is the payload directory, `{version}` the installed version; a
   * manifest that declares any gets launcher wrappers in `<home>/bin`.
   */
  env?: Record<string, string>;
  /** Launcher name inside the install's `bin/`; the first `bins` entry by default. */
  launch?: string;
  /** Binaries the install must produce (binary tools). */
  bins?: string[];
  /** The release the install downloads. */
  release: ReleaseSpec;
  /** How to turn the release's source payload into a virtualenv (also selects kind `python-venv`). */
  python?: PythonSpec;
  /** Command used to verify a fresh install, e.g. `--version`. */
  verify?: string;
}

export interface ManifestIssue {
  file: string;
  message: string;
}

export interface LoadResult {
  tools: ToolManifest[];
  issues: ManifestIssue[];
}


const PLATFORM_ASSET_KEYS = [...SUPPORTED_PLATFORMS, 'any'];

/** Keys of manifest 1 that no longer exist; a file carrying one is out of date. */
const REMOVED_TOP_LEVEL = ['fallbackRelease', 'source'];

const REMOVED_RELEASE = ['version', 'tag', 'allowSourceFallback'];

const REMOVED_PYTHON = ['path', 'archive'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `NAME=value` maps whose values are non-empty strings, e.g. `env` and `assets`. */
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

/**
 * Validates one manifest object and returns it with every default applied, or
 * every problem found.  `idHint` is the id the manifest's directory names;
 * a manifest that omits `id` takes it from there.
 */
export function validateManifest(
  value: unknown,
  file = 'manifest',
  idHint?: string,
): { manifest?: ToolManifest; errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return { errors: [`${file}: not a JSON object`] };
  }
  if (value.manifest !== 2) {
    errors.push(`${file}: unsupported "manifest" version (expected 2)`);
  }
  const id = typeof value.id === 'string' && value.id.trim() !== '' ? value.id : idHint ?? '';
  if (id === '') {
    errors.push(`${file}: missing "id" (or a directory whose name provides it)`);
  } else if (idHint !== undefined && value.id !== undefined && value.id !== idHint) {
    errors.push(`${file}: manifest id "${value.id}" does not match directory "${idHint}"`);
  }
  const summary = requireString(value, 'summary', file, errors);
  if (value.kind !== undefined) {
    errors.push(`${file}: "kind" is derived -- a "python" block makes a tool "python-venv", its absence "binary"`);
  }
  for (const key of REMOVED_TOP_LEVEL) {
    if (value[key] !== undefined) {
      errors.push(`${file}: "${key}" is not supported any more; every install comes from the release assets`);
    }
  }
  let kind: ToolKind = 'binary';
  if (isRecord(value.python)) {
    kind = 'python-venv';
    validatePython(value.python, `${file}: python`, errors);
  } else if (value.python !== undefined) {
    errors.push(`${file}: "python" must be an object`);
  }
  const release = validateRelease(value.release, id, `${file}: release`, errors);
  if (value.bins !== undefined) {
    if (!Array.isArray(value.bins) || value.bins.some((bin) => typeof bin !== 'string' || bin.trim() === '')) {
      errors.push(`${file}: bins must be a list of non-empty strings`);
    }
  }
  if (kind === 'binary' && !Array.isArray(value.bins)) {
    errors.push(`${file}: binary tools need a "bins" list naming the executables they install`);
  }
  if (kind === 'python-venv' && value.bins !== undefined) {
    errors.push(`${file}: "bins" is only supported for binary tools (the venv launcher is generated)`);
  }
  if (value.env !== undefined) {
    if (!isEnvRecord(value.env)) {
      errors.push(`${file}: env must map variable names to non-empty strings`);
    } else if (kind === 'python-venv') {
      errors.push(`${file}: env is only supported for binary tools (the venv launcher is generated)`);
    }
  }
  if (value.requires !== undefined) {
    if (!isRecord(value.requires)) {
      errors.push(`${file}: requires must be an object`);
    } else if (value.requires.python !== undefined) {
      requireString(value.requires, 'python', `${file}: requires`, errors);
    }
  }
  if (value.launch !== undefined) {
    if (isRecord(value.launch)) {
      errors.push(`${file}: launch must be the launcher name, e.g. "launch": "kuna"`);
    } else if (typeof value.launch !== 'string' || value.launch.trim() === '') {
      errors.push(`${file}: launch must be a non-empty string`);
    }
  }
  if (value.verify !== undefined) {
    if (isRecord(value.verify)) {
      errors.push(`${file}: verify must be the probe command, e.g. "verify": "--version"`);
    } else if (typeof value.verify !== 'string' || value.verify.trim() === '') {
      errors.push(`${file}: verify must be a non-empty string`);
    }
  }
  if (errors.length > 0) {
    return { errors };
  }
  const manifest: ToolManifest = {
    manifest: 2,
    id,
    kind,
    summary,
    ...(isRecord(value.homepage) ? {} : typeof value.homepage === 'string' ? { homepage: value.homepage } : {}),
    ...(typeof value.license === 'string' ? { license: value.license } : {}),
    ...(typeof value.notes === 'string' ? { notes: value.notes } : {}),
    ...(isRecord(value.requires) ? { requires: value.requires as { python?: string } } : {}),
    ...(isEnvRecord(value.env) ? { env: value.env } : {}),
    ...(typeof value.launch === 'string' ? { launch: value.launch } : {}),
    ...(Array.isArray(value.bins) ? { bins: value.bins as string[] } : {}),
    release: release as ReleaseSpec,
    ...(isRecord(value.python)
      ? {
          python: {
            ...(value.python as Record<string, unknown>),
            payload: (value.python as { payload?: string[] }).payload ?? [id],
            venv: (value.python as { venv?: string }).venv ?? '.venv',
          } as PythonSpec,
        }
      : {}),
    ...(typeof value.verify === 'string' ? { verify: value.verify } : {}),
  };
  return { manifest, errors: [] };
}

function validateRelease(
  value: unknown,
  id: string,
  where: string,
  errors: string[],
): ReleaseSpec | undefined {
  if (!isRecord(value)) {
    errors.push(`${where}: must be an object naming the release assets`);
    return undefined;
  }
  for (const key of REMOVED_RELEASE) {
    if (value[key] !== undefined) {
      errors.push(`${where}.${key} is not supported any more; releases are chosen by --version or the newest tag`);
    }
  }
  let repository = DEFAULT_RELEASE_REPOSITORY;
  if (value.repository !== undefined) {
    if (typeof value.repository !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(value.repository)) {
      errors.push(`${where}.repository must be "owner/repo"`);
    } else {
      repository = value.repository;
    }
  }
  const tagPrefix = typeof value.tagPrefix === 'string' && value.tagPrefix.trim() !== '' ? value.tagPrefix : `${id}-v`;
  if (value.tagPrefix !== undefined && typeof value.tagPrefix !== 'string') {
    errors.push(`${where}.tagPrefix must be a non-empty string`);
  }
  if (value.asset !== undefined && value.assets !== undefined) {
    errors.push(`${where}: use either "asset" (one template) or "assets" (explicit map), not both`);
  }
  let asset: string | undefined;
  if (value.asset !== undefined) {
    if (typeof value.asset !== 'string' || value.asset.trim() === '') {
      errors.push(`${where}.asset must be a non-empty asset template`);
    } else {
      asset = value.asset;
    }
  }
  if (value.assets !== undefined) {
    if (!isEnvRecord(value.assets) || Object.keys(value.assets).length === 0) {
      errors.push(`${where}.assets must map platform keys to asset names`);
    } else {
      for (const key of Object.keys(value.assets)) {
        if (!PLATFORM_ASSET_KEYS.includes(key)) {
          errors.push(`${where}.assets key "${key}" is not a platform key (${PLATFORM_ASSET_KEYS.join(', ')})`);
        }
      }
    }
  }
  if (value.asset === undefined && value.assets === undefined) {
    errors.push(`${where}: needs an "asset" template or an "assets" map`);
  }
  if (value.extraAssets !== undefined && !isEnvRecord(value.extraAssets)) {
    errors.push(`${where}.extraAssets must map names to asset names`);
  }
  const checksums =
    typeof value.checksums === 'string' && value.checksums.trim() !== ''
      ? value.checksums
      : `${id}-SHA256SUMS.txt`;
  if (value.checksums !== undefined && typeof value.checksums !== 'string') {
    errors.push(`${where}.checksums must be a non-empty string`);
  }
  if (errors.length > 0 && (asset === undefined && value.assets === undefined)) {
    return undefined;
  }
  return {
    repository,
    tagPrefix,
    ...(asset !== undefined ? { asset } : {}),
    ...(isEnvRecord(value.assets) ? { assets: value.assets } : {}),
    ...(isEnvRecord(value.extraAssets) ? { extraAssets: value.extraAssets } : {}),
    checksums,
  };
}

function validatePython(value: Record<string, unknown>, where: string, errors: string[]): void {
  for (const key of REMOVED_PYTHON) {
    if (value[key] !== undefined) {
      errors.push(`${where}.${key} is not supported any more; the source payload comes from the release assets`);
    }
  }
  for (const key of ['entry', 'requirements']) {
    const item = requireString(value, key, where, errors);
    if (!isSafeRelativePath(item)) {
      errors.push(`${where}.${key} must be a safe relative path`);
    }
  }
  if (value.payload !== undefined) {
    if (!Array.isArray(value.payload) || value.payload.some((item) => !isSafeRelativePath(item))) {
      errors.push(`${where}.payload must be a list of safe relative paths`);
    }
  }
  if (value.venv !== undefined && !isBareDirectoryName(value.venv)) {
    errors.push(`${where}.venv must be a bare directory name such as ".venv" (no path separators)`);
  }
}

/** Portable payload paths, also safe to embed in the generated shell launchers. */
export function isSafeRelativePath(value: unknown): value is string {
  return typeof value === 'string' && value.split('/').every((part) =>
    part !== '' && part !== '.' && part !== '..' && part === part.trim() && /^[a-zA-Z0-9_. -]+$/.test(part),
  );
}

/** A single path component: no separators, no `.`/`..`, no surrounding space. */
function isBareDirectoryName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value === value.trim() &&
    value !== '' &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('/') &&
    isSafeRelativePath(value)
  );
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
    const { manifest, errors } = validateManifest(parsed, file, id);
    if (manifest === undefined) {
      for (const message of errors) {
        issues.push({ file, message });
      }
      continue;
    }
    tools.push(manifest);
  }
  return { tools, issues };
}

/** Platform keys a manifest can install on, `['any']` for platform-independent payloads. */
export function supportedPlatforms(manifest: ToolManifest): string[] {
  if (manifest.kind === 'python-venv') {
    return ['any'];
  }
  const { asset, assets } = manifest.release;
  if (asset !== undefined) {
    return asset.includes('{os}') || asset.includes('{arch}') ? [...SUPPORTED_PLATFORMS] : ['any'];
  }
  const keys = Object.keys(assets ?? {}).sort();
  return keys.length > 0 ? keys : ['any'];
}

/**
 * The asset name for one platform, or null when the platform is unsupported.
 * The caller substitutes `{version}` from the release tag it resolved.
 */
export function releaseAssetFor(manifest: ToolManifest, platform: PlatformKey): string | null {
  const { release } = manifest;
  if (release.asset !== undefined) {
    return substitutePlatform(release.asset, platform);
  }
  const asset = release.assets?.[platform] ?? release.assets?.any;
  return asset ?? null;
}

/** `{os}` and `{arch}` of a platform key substituted into an asset template. */
function substitutePlatform(template: string, platform: PlatformKey): string {
  const [os, arch] = platform.split('-');
  return template.replaceAll('{os}', os ?? '').replaceAll('{arch}', arch ?? '');
}
