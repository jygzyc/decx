/**
 * Tool manifests.  One JSON file per tool under `subprojects/decx-<id>/decx-<id>.json`
 * describes where the tool comes from, how it is installed and how it is
 * launched.  A manifest is data only: the CLI never grows per-tool code.
 *
 * Installation and launch are explicit; source/release naming defaults are conventions.
 * Defaults, applied when the file loads:
 *   id              the subproject directory (`decx-<id>`)
 *   release.repository  jygzyc/decx (only when a release is declared)
 *   release.tagPrefix   `<id>-v`
 *   release.checksums   `<id>-SHA256SUMS.txt`
 *
 * `release.asset` names the per-platform asset once — `{os}`/`{arch}` are the
 * host's axes (`win`/`darwin`/`linux`, `arm64`/`amd64`), `{version}` the version
 * resolved from the tag.
 * `release.assets` maps platform keys explicitly (or to `any` for a platform-
 * independent payload) when a tool's names deviate.  The `release` block is
 * otherwise the whole story of an archive version. Direct PyPI recipes have
 * no release block: pip selects the latest package or an explicit --version.
 */

import fs from 'node:fs';
import path from 'node:path';
import { SUPPORTED_PLATFORMS, type PlatformKey } from './platform.ts';

export type LaunchType = 'bin' | 'python' | 'js';

export interface LaunchSpec {
  type: LaunchType;
  /** The first command is the tool's default; all commands are installed into bin/. */
  commands: string[];
}

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
  /** Release tag/version to install by default; `latest` resolves via GitHub REST API. */
  version?: string;
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
  /** Checksum file by default; null requires a GitHub REST asset digest instead. */
  checksums: string | null;
}

export interface ToolManifest {
  manifest: 2;
  id: string;
  /** Explicit installer recipe; DECX manages staging and the Python virtual environment. */
  install: string[];
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
  /** Runtime type and the public commands, including the default first. */
  launch: LaunchSpec;
  /** Required for binaries or pip recipes containing {source}; omitted for PyPI packages. */
  release?: ReleaseSpec;
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

const TOP_LEVEL_KEYS = new Set([
  '$schema',
  'manifest',
  'id',
  'summary',
  'homepage',
  'license',
  'notes',
  'install',
  'launch',
  'requires',
  'release',
  'env',
  'verify',
]);
const RELEASE_KEYS = new Set(['repository', 'tagPrefix', 'version', 'checksums', 'asset', 'assets', 'extraAssets']);
const REQUIREMENT_KEYS = new Set(['python']);

/** Keys of manifest 1 that no longer exist; a file carrying one is out of date. */
const REMOVED_TOP_LEVEL = ['fallbackRelease', 'source'];

const REMOVED_RELEASE = ['tag', 'allowSourceFallback'];

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

/** Launch metadata owns both the runtime choice and every public command. */
function validateLaunch(value: unknown, where: string, errors: string[]): LaunchSpec | undefined {
  if (!isRecord(value)) {
    errors.push(`${where}: must be an object with type and commands`);
    return undefined;
  }
  for (const key of Object.keys(value)) {
    if (key !== 'type' && key !== 'commands') errors.push(`${where}: unknown field "${key}"`);
  }
  if (value.type !== 'bin' && value.type !== 'python' && value.type !== 'js') {
    errors.push(`${where}.type must be "bin", "python" or "js"`);
  }
  const commands: unknown[] | undefined = Array.isArray(value.commands) ? value.commands as unknown[] : undefined;
  if (commands === undefined || commands.length === 0 ||
    commands.some((command) => !isBareDirectoryName(command))) {
    errors.push(`${where}.commands must be a non-empty list of distinct safe command names`);
    return undefined;
  }
  const names = commands as string[];
  if (new Set<string>(names).size !== names.length) {
    errors.push(`${where}.commands must be a non-empty list of distinct safe command names`);
    return undefined;
  }
  if (value.type === 'python' && names.length !== 1) {
    errors.push(`${where}: Python venv launch currently supports one console command`);
  }
  if (value.type !== 'bin' && value.type !== 'python' && value.type !== 'js') return undefined;
  return { type: value.type, commands: names };
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
  for (const key of Object.keys(value)) {
    if (REMOVED_TOP_LEVEL.includes(key)) continue;
    if (key === 'kind' || key === 'python' || key === 'bins') continue;
    if (!TOP_LEVEL_KEYS.has(key)) {
      errors.push(`${file}: unknown field "${key}"`);
    }
  }
  if (value.manifest !== 2) {
    errors.push(`${file}: unsupported "manifest" version (expected 2)`);
  }
  if (value.id !== undefined && (typeof value.id !== 'string' || value.id.trim() === '')) {
    errors.push(`${file}: id must be a non-empty string`);
  }
  const id = typeof value.id === 'string' && value.id.trim() !== '' ? value.id : idHint ?? '';
  if (id === '') {
    errors.push(`${file}: missing "id" (or a directory whose name provides it)`);
  } else if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    errors.push(`${file}: id must be a safe lowercase tool name`);
  } else if (idHint !== undefined && value.id !== undefined && value.id !== idHint) {
    errors.push(`${file}: manifest id "${value.id}" does not match directory "${idHint}"`);
  }
  const summary = requireString(value, 'summary', file, errors);
  if (value.kind !== undefined) {
    errors.push(`${file}: "kind" is derived from launch.type`);
  }
  for (const key of REMOVED_TOP_LEVEL) {
    if (value[key] !== undefined) {
      errors.push(`${file}: "${key}" is not supported any more; every install comes from the release assets`);
    }
  }
  const optionalTextKeys: string[] = ['homepage', 'license', 'notes'];
  for (const key of optionalTextKeys) {
    if (value[key] !== undefined && typeof value[key] !== 'string') {
      errors.push(`${file}: "${key}" must be a string`);
    }
  }
  const launch = validateLaunch(value.launch, `${file}: launch`, errors);
  const kind = launch?.type === 'python' ? 'python-venv' : 'binary';
  const recipe: unknown[] | undefined = Array.isArray(value.install) ? value.install as unknown[] : undefined;
  if (recipe === undefined || recipe.length === 0 ||
    recipe.some((arg) => typeof arg !== 'string' || arg.trim() === '')) {
    errors.push(`${file}: install must be a non-empty argv array`);
  } else if (kind === 'binary' && (recipe.length !== 1 || recipe[0] !== 'github-release')) {
    errors.push(`${file}: bin/js launch requires install: ["github-release"]`);
  } else if (kind === 'python-venv' && (recipe.length < 3 || recipe[0] !== 'pip' || recipe[1] !== 'install')) {
    errors.push(`${file}: python launch requires install: ["pip", "install", ...]`);
  }
  if (value.python !== undefined) errors.push(`${file}: python is obsolete; declare pip install arguments in "install"`);
  if (value.bins !== undefined) errors.push(`${file}: "bins" is obsolete; declare commands under "launch"`);
  const usesSource = kind === 'python-venv' && recipe !== undefined &&
    recipe.some((arg: unknown) => typeof arg === 'string' && arg.includes('{source}'));
  const requiresRelease = kind === 'binary' || usesSource;
  const release = value.release === undefined && !requiresRelease ? undefined : validateRelease(value.release, id, `${file}: release`, errors);
  if (kind === 'python-venv' && !usesSource && value.release !== undefined) {
    errors.push(`${file}: PyPI install recipes must not declare release assets`);
  }
  if (kind === 'python-venv' && !usesSource && recipe !== undefined &&
    (typeof recipe[2] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(recipe[2]))) {
    errors.push(`${file}: PyPI install recipes must name a package immediately after install`);
  }
  if (value.env !== undefined) {
    if (!isEnvRecord(value.env)) {
      errors.push(`${file}: env must map variable names to non-empty strings`);
    } else if (launch?.type !== 'bin') {
      errors.push(`${file}: env is only supported for bin tools (interpreter launchers are generated)`);
    }
  }
  if (kind === 'binary' && value.requires !== undefined) {
    errors.push(`${file}: requires is only supported for Python tools`);
  }
  if (value.requires !== undefined) {
    if (!isRecord(value.requires)) {
      errors.push(`${file}: requires must be an object`);
    } else {
      for (const key of Object.keys(value.requires)) {
        if (!REQUIREMENT_KEYS.has(key)) {
          errors.push(`${file}: requires has unknown field "${key}"`);
        }
      }
      if (value.requires.python !== undefined) {
        requireString(value.requires, 'python', `${file}: requires`, errors);
      }
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
    install: value.install as string[],
    summary,
    ...(typeof value.homepage === 'string' ? { homepage: value.homepage } : {}),
    ...(typeof value.license === 'string' ? { license: value.license } : {}),
    ...(typeof value.notes === 'string' ? { notes: value.notes } : {}),
    ...(isRecord(value.requires) ? { requires: value.requires as { python?: string } } : {}),
    ...(isEnvRecord(value.env) ? { env: value.env } : {}),
    launch: launch!,
    ...(release !== undefined ? { release } : {}),
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
  for (const key of Object.keys(value)) {
    if (REMOVED_RELEASE.includes(key)) continue;
    if (!RELEASE_KEYS.has(key)) {
      errors.push(`${where}: unknown field "${key}"`);
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
  const version = typeof value.version === 'string' && value.version.trim() !== '' ? value.version : 'latest';
  if (value.version !== undefined && (typeof value.version !== 'string' || value.version.trim() === '')) {
    errors.push(`${where}.version must be a non-empty release version or "latest"`);
  }
  if (value.tagPrefix !== undefined && (typeof value.tagPrefix !== 'string' || value.tagPrefix.trim() === '')) {
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
  const checksums = value.checksums === null ? null :
    typeof value.checksums === 'string' && value.checksums.trim() !== ''
      ? value.checksums
      : `${id}-SHA256SUMS.txt`;
  if (value.checksums !== undefined && value.checksums !== null && (typeof value.checksums !== 'string' || value.checksums.trim() === '')) {
    errors.push(`${where}.checksums must be a non-empty string or null for GitHub asset digests`);
  }
  if (errors.length > 0 && (asset === undefined && value.assets === undefined)) {
    return undefined;
  }
  return {
    repository,
    tagPrefix,
    version,
    ...(asset !== undefined ? { asset } : {}),
    ...(isEnvRecord(value.assets) ? { assets: value.assets } : {}),
    ...(isEnvRecord(value.extraAssets) ? { extraAssets: value.extraAssets } : {}),
    checksums,
  };
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
    !/\s/.test(value) &&
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
  if (manifest.launch.type === 'python') {
    return ['any'];
  }
  const { asset, assets } = manifest.release!;
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
  if (release === undefined) return null;
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
