/**
 * Tool manifests in the central `third_party/tools.json` catalog describe
 * where each tool comes from, how it is installed and how it is
 * launched.  A manifest is data only: the CLI never grows per-tool code.
 *
 * The catalog root declares manifest: 1; entries are unversioned.
 * Installation and launch are explicit. Releases use tool.repo, discover stable
 * tags by matching assets, and require GitHub REST SHA-256 digests by default.
 *
 * `release.asset` names the per-platform asset once — `{os}`/`{arch}` are the
 * host's axes (`win`/`darwin`/`linux`, `arm64`/`amd64`), `{version}` the version
 * resolved from the tag.
 * `release.assets` maps platform keys explicitly (or to `any` for a platform-
 * independent payload) when a tool's names deviate.  The `release` block is
 * otherwise the whole story of an archive version. Direct PyPI recipes have
 * no release block: pip selects the latest package or an explicit --version.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { SUPPORTED_PLATFORMS } from '../core/platform.ts';

export type LaunchType = 'bin' | 'python' | 'js';

export interface LaunchSpec {
  type: LaunchType;
  /** The first command is the tool's default; all commands are installed into bin/. */
  commands: string[];
}

/** The tool's release; one release per version, assets named per platform. */
export interface ReleaseSpec {
  /** Internal GitHub repository, derived only from tool.repo. */
  repository: string;
  /**
   * Tag prefix of this tool's releases, e.g. `kuna-v` when versions are tagged
   * `kuna-v1.544`.  `decx install <id>` installs the newest matching release;
   * `--version <tag|version>` picks one explicitly.
   */
  tagPrefix?: string;
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
  /** Explicit checksum file; null (the default) requires GitHub REST asset digests. */
  checksums: string | null;
}

export interface ToolManifest {
  id: string;
  /** Required GitHub source repository, in owner/repo form. */
  repo: string;
  /** Explicit installer recipe; DECX manages staging and the Python virtual environment. */
  install: string[];
  summary: string;
  license?: string;
  /** Free-form caveat shown by `list`. */
  notes?: string;
  /** Runtime kind; inferred from launch.type when omitted. */
  requires: LaunchType;
  /**
   * Environment the tool's launchers export before running the packaged binary,
   * e.g. where a release payload keeps data the tool has to find by itself.
   * `{prefix}` is the payload directory, `{version}` the installed version; a
   * manifest that declares any gets launcher wrappers in `<home>/bin`.
   */
  env?: Record<string, string>;
  /** Runtime type and the public commands, including the default first. */
  launch: LaunchSpec;
  /** Required for release archives; omitted for PyPI packages. */
  release?: ReleaseSpec;
  /** Command used to verify a fresh install, e.g. `--version`. */
  verify?: string;
}

/** The `verify` command split into arguments, e.g. `--version --json`. */
export function verifyArgs(manifest: ToolManifest): string[] {
  return (manifest.verify ?? '')
    .trim()
    .split(/\s+/)
    .filter((part) => part !== '');
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
  'id',
  'summary',
  'repo',
  'license',
  'notes',
  'install',
  'launch',
  'requires',
  'release',
  'env',
  'verify',
]);
const RELEASE_KEYS = new Set(['tagPrefix', 'version', 'checksums', 'asset', 'assets', 'extraAssets']);

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
 * every problem found. Every catalog entry requires an explicit tool id.
 */
export function validateManifest(
  value: unknown,
  file = 'manifest',
): { manifest?: ToolManifest; errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return { errors: [`${file}: not a JSON object`] };
  }
  for (const key of Object.keys(value)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      errors.push(`${file}: unknown field "${key}"`);
    }
  }
  const id = requireString(value, 'id', file, errors);
  if (id !== '' && !/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    errors.push(`${file}: id must be a safe lowercase tool name`);
  }
  const repo = requireString(value, 'repo', file, errors);
  if (repo !== '' && !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repo)) {
    errors.push(`${file}: repo must be "owner/repo"`);
  }
  const summary = requireString(value, 'summary', file, errors);
  const optionalTextKeys: string[] = ['license', 'notes'];
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
  const release = kind === 'binary' ? validateRelease(value.release, repo, `${file}: release`, errors) : undefined;
  if (kind === 'python-venv' && value.release !== undefined) {
    errors.push(`${file}: PyPI install recipes must not declare release assets`);
  }
  if (kind === 'python-venv' && recipe !== undefined &&
    (typeof recipe[2] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(recipe[2]))) {
    errors.push(`${file}: PyPI install recipes must name a package immediately after install`);
  }
  if (value.env !== undefined) {
    if (!isEnvRecord(value.env)) {
      errors.push(`${file}: env must map variable names to non-empty strings`);
    } else if (Object.keys(value.env).length > 0 && launch?.type !== 'bin') {
      errors.push(`${file}: env is only supported for bin tools (interpreter launchers are generated)`);
    }
  }
  if (value.requires !== undefined) {
    if (value.requires !== 'bin' && value.requires !== 'python' && value.requires !== 'js') {
      errors.push(`${file}: requires must be "bin", "python" or "js"`);
    } else if (value.requires !== launch?.type) {
      errors.push(`${file}: requires must match launch.type`);
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
    id,
    repo,
    install: value.install as string[],
    summary,
    ...(typeof value.license === 'string' ? { license: value.license } : {}),
    ...(typeof value.notes === 'string' ? { notes: value.notes } : {}),
    requires: launch!.type,
    ...(isEnvRecord(value.env) ? { env: value.env } : {}),
    launch: launch!,
    ...(release !== undefined ? { release } : {}),
    ...(typeof value.verify === 'string' ? { verify: value.verify } : {}),
  };
  return { manifest, errors: [] };
}

function validateRelease(
  value: unknown,
  repository: string,
  where: string,
  errors: string[],
): ReleaseSpec | undefined {
  if (!isRecord(value)) {
    errors.push(`${where}: must be an object naming the release assets`);
    return undefined;
  }
  for (const key of Object.keys(value)) {
    if (!RELEASE_KEYS.has(key)) {
      errors.push(`${where}: unknown field "${key}"`);
    }
  }
  const tagPrefix = typeof value.tagPrefix === 'string' && value.tagPrefix.trim() !== '' ? value.tagPrefix : undefined;
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
  const checksums = typeof value.checksums === 'string' && value.checksums.trim() !== '' ? value.checksums : null;
  if (value.checksums !== undefined && value.checksums !== null && (typeof value.checksums !== 'string' || value.checksums.trim() === '')) {
    errors.push(`${where}.checksums must be a non-empty string or null for GitHub asset digests`);
  }
  if (errors.length > 0 && (asset === undefined && value.assets === undefined)) {
    return undefined;
  }
  return {
    repository,
    ...(tagPrefix !== undefined ? { tagPrefix } : {}),
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

/**
 * Loads only `dir/tools.json`. Invalid entries are reported as issues without
 * blocking valid tools; duplicate ids keep the first valid entry.
 */
export function loadManifests(dir: string): LoadResult {
  const tools: ToolManifest[] = [];
  const issues: ManifestIssue[] = [];
  const file = path.join(dir, 'tools.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return { tools, issues: [{ file, message: `cannot read tool catalog: ${(error as Error).message}` }] };
  }
  if (!isRecord(parsed)) {
    return { tools, issues: [{ file, message: `${file}: not a JSON object` }] };
  }
  for (const key of Object.keys(parsed)) {
    if (key !== '$schema' && key !== 'manifest' && key !== 'tools') {
      issues.push({ file, message: `${file}: unknown field "${key}"` });
    }
  }
  if (parsed.manifest !== 1) {
    issues.push({ file, message: `${file}: unsupported "manifest" version (expected 1)` });
  }
  if (parsed.$schema !== undefined && parsed.$schema !== './decx-tool.schema.json') {
    issues.push({ file, message: `${file}: "$schema" must be "./decx-tool.schema.json"` });
  }
  if (!Array.isArray(parsed.tools) || parsed.tools.length === 0) {
    issues.push({ file, message: `${file}: tools must be a non-empty array` });
    return { tools, issues };
  }
  if (issues.length > 0) return { tools, issues };
  const ids = new Set<string>();
  let index = 0;
  for (const entry of parsed.tools) {
    const entryFile = `${file}#tools/${index}`;
    index += 1;
    const { manifest, errors } = validateManifest(entry, entryFile);
    if (manifest === undefined) {
      for (const message of errors) issues.push({ file: entryFile, message });
      continue;
    }
    if (ids.has(manifest.id)) {
      issues.push({ file: entryFile, message: `${entryFile}: duplicate tool id "${manifest.id}"` });
      continue;
    }
    ids.add(manifest.id);
    tools.push(manifest);
  }
  return { tools, issues };
}
