/**
 * Install upstream release archives or PyPI packages into an isolated stage,
 * then atomically commit executables, payload, launch metadata and PROVENANCE.
 * Python virtualenvs are initialized at their permanent path under rollback.
 * Runtimes are probed, never installed.
 */

import { defaultRunner, type CommandResult } from './runner.ts';
import { launcherText, shellQuote, type LaunchEntry } from './launch.ts';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { extractArchive } from './archive.ts';
import { lstatIfPresent } from './fs.ts';
import { binRoot, resolveLinkDir, runtimePath, toolPrefix } from './config.ts';
import { createLinks, removeManagedLink, type LinkOutcome } from './links.ts';
import {
  DEFAULT_API_BASE,
  DEFAULT_DOWNLOAD_BASE,
  DEFAULT_USER_AGENT,
  GithubError,
  downloadAsset,
  githubToken,
  parseChecksums,
  releaseAssetDigests,
  releaseDownloadUrl,
  resolveRelease,
} from './gh.ts';
import { isSafeRelativePath, type ReleaseSpec, type ToolManifest } from './manifest.ts';
import { provenanceBinaries, readProvenance } from './inspect.ts';
import { currentPlatformKey, isWindows, type PlatformKey } from './platform.ts';

export type InstallMethod = 'release download' | 'python venv';

export interface InstallContext {
  /** DECX_HOME root; the tool prefix is `<home>/share/<id>`. */
  home: string;
  env?: NodeJS.ProcessEnv;
  /** Overrides the host platform key (tests use it to pin an asset). */
  platform?: PlatformKey | null;
  apiBase?: string;
  downloadBase?: string;
}

export interface InstallOptions {
  /** Explicit release tag or version; `1.544` and `kuna-v1.544` are normalised. */
  version?: string;
  /** Link directory for the PATH entries; `--links`/`$DECX_LINKS_DIR`, else ~/.local/bin. */
  links?: string;
  /** Skip creating PATH links entirely. */
  noLinks?: boolean;
  /** Replace files in the store or link directory that decx did not create. */
  force?: boolean;
}

export interface InstallResult {
  id: string;
  method: InstallMethod;
  prefix: string;
  binDir: string;
  launcher: string;
  binaries: string[];
  version?: string;
  releaseTag?: string;
  releaseSource?: string;
  asset?: string;
  specsAsset?: string;
  specsInstalled?: number;
  checksum?: string;
  provenance: Record<string, string>;
  pathHint: string;
  /** PATH links created or refreshed by this install. */
  links?: LinkOutcome[];
  linkDir?: string;
}

export class InstallError extends Error {
  readonly code: string;
  readonly hint: string | undefined;
  readonly exitCode: number;

  constructor(code: string, message: string, options: { hint?: string; exitCode?: number } = {}) {
    super(message);
    this.name = 'InstallError';
    this.code = code;
    this.hint = options.hint;
    this.exitCode = options.exitCode ?? 1;
  }
}

interface ResolvedContext {
  home: string;
  env: NodeJS.ProcessEnv;
  platform: PlatformKey | null;
  apiBase: string;
  downloadBase: string;
  log: (line: string) => void;
}

interface StagedOutcome {
  entry: LaunchEntry;
  /** Runs after the payload reaches its permanent path, while backups still exist. */
  initialize?: () => Promise<void>;
  provenance: Record<string, string>;
  binaries: string[];
  launcherName: string;
  method: InstallMethod;
  version?: string;
  releaseTag?: string;
  releaseSource?: string;
  asset?: string;
  specsAsset?: string;
  specsInstalled?: number;
  checksum?: string;
}

function resolveContext(context: InstallContext): ResolvedContext {
  return {
    home: context.home,
    env: context.env ?? process.env,
    platform: context.platform !== undefined ? context.platform : currentPlatformKey(),
    apiBase: context.apiBase ?? DEFAULT_API_BASE,
    downloadBase: context.downloadBase ?? DEFAULT_DOWNLOAD_BASE,
    log: (line: string) => process.stderr.write(`${line}\n`),
  };
}

async function runCommand(
  ctx: ResolvedContext,
  command: string,
  args: string[],
  mode: 'capture' | 'stream' = 'capture',
  extraEnv?: Record<string, string>,
): Promise<CommandResult> {
  return defaultRunner({ command, args, mode, env: { ...ctx.env, ...extraEnv } });
}

function assertInstallRoot(home: string): string {
  const resolved = path.resolve(home);
  if (resolved === path.dirname(resolved)) {
    throw new InstallError('UNSAFE_PREFIX', `refusing to install directly into ${resolved}`, { exitCode: 2 });
  }
  if (resolved === path.resolve(os.homedir())) {
    throw new InstallError('UNSAFE_PREFIX', 'refusing to install directly into $HOME; use $HOME/.decx or --home <dir>', {
      exitCode: 2,
    });
  }
  return resolved;
}

/** `1.508` -> `v1.508`, `0.1.0` with tag prefix `tools-v` -> `tools-v0.1.0`. */
export function normalizeReleaseTag(tag: string, tagPrefix?: string): string {
  const value = tag.trim();
  if (value === '') {
    throw new InstallError('USAGE', 'release tag must not be empty', { exitCode: 2 });
  }
  if (tagPrefix !== undefined && tagPrefix !== '') {
    if (value.startsWith(tagPrefix)) {
      return value;
    }
    return `${tagPrefix}${value.startsWith('v') ? value.slice(1) : value}`;
  }
  return /^\d/.test(value) ? `v${value}` : value;
}

/** `tools-v0.1.0` with prefix `tools-v` -> `0.1.0`; `v1.508` -> `1.508`. */
export function releaseVersionFromTag(tag: string, tagPrefix?: string): string {
  let value = tag;
  if (tagPrefix !== undefined && tagPrefix !== '' && value.startsWith(tagPrefix)) {
    value = value.slice(tagPrefix.length);
  }
  return value.startsWith('v') ? value.slice(1) : value;
}

/** The asset for one platform with `{version}`/`{os}`/`{arch}` substituted, or null. */
export function releaseAssetName(release: ReleaseSpec, platform: PlatformKey | null, version: string): string | null {
  if (release.asset !== undefined) {
    if (platform === null) {
      return null;
    }
    const [os, arch] = platform.split('-');
    return release.asset.replaceAll('{version}', version).replaceAll('{os}', os ?? '').replaceAll('{arch}', arch ?? '');
  }
  const template = (platform === null ? undefined : release.assets?.[platform]) ?? release.assets?.any;
  return template === undefined ? null : template.replaceAll('{version}', version);
}

/** The `verify` command split into arguments, e.g. `--version --json`. */
export function verifyArgs(manifest: ToolManifest): string[] {
  return (manifest.verify ?? '')
    .trim()
    .split(/\s+/)
    .filter((part) => part !== '');
}

/** `key: value` lines with indented continuations for multi-line values. */
export function formatProvenance(record: Record<string, string>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    const parts = value.split('\n');
    lines.push(`${key}: ${parts[0] ?? ''}`);
    for (const part of parts.slice(1)) {
      lines.push(`  ${part}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/** Exact PATH instructions; the installer never edits shell startup files. */
export function pathHint(binDir: string, windows: boolean = isWindows()): string {
  return windows ? `set PATH=${binDir};%PATH%` : `export PATH="${binDir}:$PATH"`;
}

/**
 * Manifest `env` with its placeholders resolved: `{prefix}` is the payload
 * directory and `{version}` the installed version.  `undefined` when the
 * manifest has nothing to export.
 */
export function launcherEnv(
  manifest: ToolManifest,
  prefix: string,
  version: string,
): Record<string, string> | undefined {
  const env = manifest.env;
  if (env === undefined) {
    return undefined;
  }
  const resolved: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    const expanded = value.replaceAll('{prefix}', prefix).replaceAll('{version}', version);
    resolved[name] = value.includes('{prefix}') ? path.normalize(expanded) : expanded;
  }
  return Object.keys(resolved).length === 0 ? undefined : resolved;
}

/** `env` as a PROVENANCE value: `NAME='value' NAME2='value2'`. */
export function formatEnv(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([name, value]) => `${name}=${shellQuote(value)}`)
    .join(' ');
}

/** Store name of a wrapped binary: the archive's `kuna.exe` is exposed as `kuna.cmd`. */
export function launcherStoreName(staged: string): string {
  return /\.exe$/i.test(staged) ? `${staged.slice(0, -4)}.cmd` : staged;
}

function isoTimestamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function firstLine(result: CommandResult): string {
  const text = `${result.stdout}\n${result.stderr}`.trim();
  return text.split(/\r?\n/)[0] ?? '';
}

function listDirEntries(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function walkFiles(root: string): string[] {
  const files: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    for (const entry of listDirEntries(dir)) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        files.push(full);
      }
    }
  }
  return files;
}

function findFile(root: string, names: readonly string[]): string | null {
  const files = walkFiles(root);
  for (const name of names) {
    const hit = files.find((file) => path.basename(file) === name);
    if (hit !== undefined) {
      return hit;
    }
  }
  return null;
}

function countBySuffix(root: string, suffix: string): number {
  return walkFiles(root).filter((file) => file.endsWith(suffix)).length;
}

function findSpecsDir(extract: string): string | null {
  const stack = [extract];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    if (path.basename(dir) === 'specs' && countBySuffix(dir, '.sla') > 0) {
      return dir;
    }
    for (const entry of listDirEntries(dir)) {
      if (entry.isDirectory()) {
        stack.push(path.join(dir, entry.name));
      }
    }
  }
  return null;
}

function applyExecutableMode(file: string): void {
  if (process.platform === 'win32') {
    return;
  }
  fs.chmodSync(file, 0o755);
}

function copyExecutable(source: string, dest: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(source, dest);
  applyExecutableMode(dest);
}

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function pickLauncher(manifest: ToolManifest, binaries: readonly string[]): string {
  const wanted = manifest.launch.commands[0] as string;
  const found = binaries.find((name) => path.basename(name, path.extname(name)) === wanted);
  if (found !== undefined) {
    return found;
  }
  const first = binaries[0];
  if (first === undefined) {
    throw new InstallError('INSTALL_EMPTY', `${manifest.id} produced no binaries`);
  }
  return first;
}

/** First `1.2` / `1.2.3` in a version banner. */
function firstVersion(text: string): string | undefined {
  return /(\d+)\.(\d+)(?:\.\d+)?/.exec(text)?.[0];
}

function compareVersions(a: string, b: string): number {
  const left = a.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const right = b.split('.').map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) {
      return difference > 0 ? 1 : -1;
    }
  }
  return 0;
}

/** `>=3.10` and bare `3.10` are the only requirement forms the manifests use. */
function meetsRequirement(version: string, requirement: string): boolean {
  const match = /^(>=|>|=)?\s*(\d+(?:\.\d+)*)$/.exec(requirement.trim());
  if (match === null) {
    return true;
  }
  const comparator = match[1] ?? '>=';
  const difference = compareVersions(version, match[2] as string);
  if (comparator === '>') {
    return difference > 0;
  }
  return comparator === '=' ? difference === 0 : difference >= 0;
}

interface PythonCandidate {
  /** Interpreter command name, e.g. `python3.12`. */
  command: string;
  /** Leading arguments the command needs, e.g. `-3.12` for the Windows launcher. */
  args: string[];
  /** Human-readable form for messages and PROVENANCE, e.g. `python3.12` or `py -3.12`. */
  label: string;
}

/** Interpreter names to probe for a venv install, PATH defaults first. */
function pythonCandidates(ctx: ResolvedContext): PythonCandidate[] {
  // An explicit `DECX_PYTHON` is used as given: the caller knows the machine.
  const override = (ctx.env.DECX_PYTHON ?? '').trim();
  if (override !== '') {
    return [{ command: override, args: [], label: override }];
  }
  const candidates: PythonCandidate[] = [
    { command: 'python3', args: [], label: 'python3' },
    { command: 'python', args: [], label: 'python' },
  ];
  if (isWindows()) {
    candidates.push({ command: 'py', args: ['-3'], label: 'py -3' });
  }
  // Newest first: the first candidate that satisfies the manifest wins, so a
  // too-old default is skipped in favour of an explicitly versioned interpreter.
  for (const minor of [15, 14, 13, 12, 11, 10]) {
    candidates.push({ command: `python3.${minor}`, args: [], label: `python3.${minor}` });
    if (isWindows()) {
      candidates.push({ command: 'py', args: [`-3.${minor}`], label: `py -3.${minor}` });
    }
  }
  return candidates;
}

/**
 * Finds the interpreter a venv install will use.  `python3`/`python` win when
 * they satisfy the manifest; otherwise the versioned names are probed and the
 * first satisfying one is used, so a manifest that needs `>=3.10` still
 * installs on a machine whose default `python3` is the system 3.9.
 */
async function findPython(
  ctx: ResolvedContext,
  id: string,
  requirement: string | undefined,
): Promise<PythonCandidate & { output: string }> {
  let fallback: (PythonCandidate & { output: string }) | null = null;
  for (const candidate of pythonCandidates(ctx)) {
    const probe = await runCommand(ctx, candidate.command, [...candidate.args, '--version']);
    if (probe.error !== undefined || probe.status !== 0) {
      continue;
    }
    const output = firstLine(probe);
    if (!output.startsWith('Python 3')) {
      continue;
    }
    const found = { command: candidate.command, args: candidate.args, label: candidate.label, output };
    fallback ??= found;
    const version = firstVersion(output);
    if (requirement === undefined || version === undefined || meetsRequirement(version, requirement)) {
      return found;
    }
  }
  if (fallback !== null) {
    throw new InstallError(
      'PYTHON_TOO_OLD',
      `${fallback.output} (${fallback.label}) is too old: ${id} requires python ${requirement}. Install a newer Python 3 (macOS: 'brew install python@3.12'; Debian/Ubuntu: 'apt install python3 python3-venv'; Windows: python.org or 'winget install Python.Python.3') and re-run; decx does not install it for you.`,
    );
  }
  throw new InstallError(
    'PYTHON_NOT_FOUND',
    "no Python 3 interpreter found in PATH (looked for python3, python and versioned names such as python3.12). Install Python 3 with the venv module (Debian/Ubuntu: 'apt install python3 python3-venv'; macOS: 'brew install python3'; Windows: python.org or 'winget install Python.Python.3') and re-run; decx does not install it for you.",
  );
}

async function resolveInstallTag(ctx: ResolvedContext, release: ReleaseSpec, options: InstallOptions): Promise<string> {
  const requested = options.version ?? release.version;
  if (requested !== undefined && requested !== 'latest' && requested.trim() !== '') {
    return normalizeReleaseTag(requested, release.tagPrefix);
  }
  try {
    const token = githubToken(ctx.env);
    const resolved = await resolveRelease({
      repository: release.repository,
      tagPrefix: release.tagPrefix,
      ...(token !== undefined ? { token } : {}),
      apiBase: ctx.apiBase,
      userAgent: DEFAULT_USER_AGENT,
    });
    return resolved.tag;
  } catch (error) {
    throw new InstallError('RELEASE_RESOLVE_FAILED', `could not resolve a release of ${release.repository}: ${(error as Error).message}`, {
      hint: 'pass --version <tag> to pick a release explicitly',
    });
  }
}

async function downloadRequired(ctx: ResolvedContext, url: string, dest: string) {
  ctx.log(`downloading ${url}`);
  const token = githubToken(ctx.env);
  try {
    return await downloadAsset(url, dest, {
      ...(token !== undefined ? { token } : {}),
      userAgent: DEFAULT_USER_AGENT,
    });
  } catch (error) {
    if (!(error instanceof GithubError) || error.code !== 'DOWNLOAD_FAILED') {
      throw error;
    }
    throw new InstallError('DOWNLOAD_FAILED', error.message, { hint: 'check the source, release tag and network access' });
  }
}

function checkDigest(asset: string, expected: string, actual: string): void {
  if (expected.toLowerCase() !== actual) {
    throw new InstallError(
      'CHECKSUM_MISMATCH',
      `checksum mismatch for ${asset}: expected ${expected}, got ${actual}. Refusing to install.`,
      { hint: 'delete the release or report it instead' },
    );
  }
}

/** Load one integrity map per release; every primary/extra asset must appear in it. */
async function releaseChecksums(ctx: ResolvedContext, release: ReleaseSpec, tag: string, downloads: string): Promise<Map<string, string>> {
  const token = githubToken(ctx.env);
  const authentication = { ...(token !== undefined ? { token } : {}), userAgent: DEFAULT_USER_AGENT };
  try {
    if (release.checksums === null) {
      return await releaseAssetDigests({ ...authentication, repository: release.repository, tag, apiBase: ctx.apiBase });
    }
    const name = release.checksums.replaceAll('{version}', releaseVersionFromTag(tag, release.tagPrefix));
    safeAssetName(name);
    await downloadAsset(releaseDownloadUrl(ctx.downloadBase, release.repository, tag, name), path.join(downloads, name), authentication);
    return parseChecksums(fs.readFileSync(path.join(downloads, name), 'utf8'));
  } catch (error) {
    if (error instanceof InstallError) throw error;
    throw new InstallError('CHECKSUM_DOWNLOAD_FAILED', `could not load required checksums for ${tag}: ${(error as Error).message}. Refusing to install unverified assets.`);
  }
}

function verifyChecksum(ctx: ResolvedContext, asset: string, actual: string, checksums: Map<string, string>): string {
  const expected = checksums.get(asset);
  if (expected === undefined) throw new InstallError('CHECKSUM_MISSING', `release checksums have no entry for ${asset}. Refusing to install an unverified asset.`);
  checkDigest(asset, expected, actual);
  ctx.log(`checksum verified: ${actual}`);
  return `verified (${actual})`;
}

function safeAssetName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(name) || name === '..') {
    throw new InstallError('INVALID_MANIFEST', `unsafe release asset filename: ${JSON.stringify(name)}`);
  }
}

interface ReleaseArchive {
  extract: string;
  version: string;
  asset: string;
  sha256: string;
  checksum: string;
  specsAsset?: string;
  extraProvenance: Record<string, string>;
}

/** The release transport: one platform asset plus the extra assets every install needs. */
async function downloadRelease(
  ctx: ResolvedContext,
  release: ReleaseSpec,
  stage: string,
  tag: string,
): Promise<ReleaseArchive> {
  const version = releaseVersionFromTag(tag, release.tagPrefix);
  const asset = releaseAssetName(release, ctx.platform, version);
  if (asset === null) {
    throw new InstallError('UNSUPPORTED_PLATFORM', `no archive is defined for this platform (${ctx.platform ?? `${process.platform}-${process.arch}`})`, {
      hint: 'the release does not publish an asset for this platform',
    });
  }
  safeAssetName(asset);
  const downloads = path.join(stage, 'downloads');
  const extract = path.join(stage, 'extract');
  fs.mkdirSync(downloads, { recursive: true });
  fs.mkdirSync(extract, { recursive: true });
  const checksums = await releaseChecksums(ctx, release, tag, downloads);
  const assetUrl = releaseDownloadUrl(ctx.downloadBase, release.repository, tag, asset);
  const { sha256 } = await downloadRequired(ctx, assetUrl, path.join(downloads, asset));
  const checksum = verifyChecksum(ctx, asset, sha256, checksums);
  extractArchive(path.join(downloads, asset), extract);
  let specsAsset: string | undefined;
  const extraProvenance: Record<string, string> = {};
  for (const [key, template] of Object.entries(release.extraAssets ?? {})) {
    const extraName = template.replaceAll('{version}', version);
    safeAssetName(extraName);
    const extraUrl = releaseDownloadUrl(ctx.downloadBase, release.repository, tag, extraName);
    const download = await downloadRequired(ctx, extraUrl, path.join(downloads, extraName));
    const extraChecksum = verifyChecksum(ctx, extraName, download.sha256, checksums);
    extraProvenance[`${key}_sha256`] = download.sha256;
    extraProvenance[`${key}_checksum`] = extraChecksum;
    extractArchive(path.join(downloads, extraName), extract);
    if (key === 'specs') {
      specsAsset = extraName;
    }
  }
  return { extract, version, asset, sha256, checksum, extraProvenance, ...(specsAsset !== undefined ? { specsAsset } : {}) };
}

function stageJavascriptRelease(
  manifest: ToolManifest,
  extract: string,
  stage: string,
  asset: string,
  windows: boolean,
  prefix: string,
): { binaries: string[]; verifyScript: string } {
  const binaries: string[] = [];
  let verifyScript = '';
  const app = path.join(stage, 'share', manifest.id, 'app');
  fs.mkdirSync(path.dirname(app), { recursive: true });
  fs.renameSync(extract, app);
  fs.mkdirSync(path.join(stage, 'bin'), { recursive: true });
  for (const name of manifest.launch.commands) {
    const found = findFile(app, [`${name}.mjs`, `${name}.cjs`, `${name}.js`]);
    if (found === null) {
      throw new InstallError('ASSET_LAYOUT', `'${asset}' does not contain a Node script for '${name}' (.mjs, .cjs or .js)`);
    }
    const script = path.relative(app, found).split(path.sep).join('/');
    if (!isSafeRelativePath(script)) {
      throw new InstallError('ASSET_LAYOUT', `'${asset}' has an unsafe Node script path: ${script}`);
    }
    const launcher = windows ? `${name}.cmd` : name;
    fs.writeFileSync(
      path.join(stage, 'bin', launcher),
      launcherText({ command: 'node', args: [path.join(prefix, 'app', script)] }, windows),
    );
    if (!windows) fs.chmodSync(path.join(stage, 'bin', launcher), 0o755);
    binaries.push(launcher);
    if (verifyScript === '') verifyScript = path.join(app, script);
  }
  return { binaries, verifyScript };
}

async function stageRelease(
  ctx: ResolvedContext,
  manifest: ToolManifest,
  release: ReleaseSpec,
  options: InstallOptions,
  prefix: string,
  stage: string,
  tag: string,
): Promise<StagedOutcome> {
  const { extract, version, asset, sha256, checksum, specsAsset, extraProvenance } = await downloadRelease(ctx, release, stage, tag);
  const share = path.join(stage, 'share', manifest.id);
  fs.mkdirSync(share, { recursive: true });
  let verifyScript: string | undefined;
  const binaries: string[] = [];
  if (manifest.launch.type === 'js') {
    const staged = stageJavascriptRelease(manifest, extract, stage, asset, isWindows(), prefix);
    binaries.push(...staged.binaries);
    verifyScript = staged.verifyScript;
  } else {
    for (const name of manifest.launch.commands) {
      const found = findFile(extract, [name, `${name}.exe`]);
      if (found === null) {
        throw new InstallError(
          'ASSET_LAYOUT',
          `'${asset}' does not contain '${name}' (or '${name}.exe'). The release layout may have changed; try another --version.`,
        );
      }
      const installed = path.basename(found);
      copyExecutable(found, path.join(stage, 'bin', installed));
      binaries.push(installed);
    }
  }
  const launcherName = pickLauncher(manifest, binaries);
  let specsInstalled = 0;
  if (specsAsset !== undefined) {
    const payload = manifest.launch.type === 'js' ? path.join(stage, 'share', manifest.id, 'app') : extract;
    const specsSource = findSpecsDir(payload);
    if (specsSource === null) {
      throw new InstallError(
        'SPECS_MISSING',
        `the downloaded archives do not contain a specs/ tree with compiled .sla files. Try another --version.`,
      );
    }
    fs.renameSync(specsSource, path.join(share, 'specs'));
    specsInstalled = countBySuffix(path.join(share, 'specs'), '.sla');
    if (specsInstalled === 0) {
      throw new InstallError('SPECS_MISSING', 'no .sla files found in the downloaded specs tree; refusing to install an uncompiled tree.');
    }
    ctx.log(`staged ${specsInstalled} compiled .sla files`);
  }
  const launcherPath = path.join(stage, 'bin', launcherName);
  let reported = '';
  const args = verifyArgs(manifest);
  if (args.length > 0) {
    // The payload is still the stage here, so `{prefix}` has to resolve to the
    // staged tree -- that is the copy the probe is about to exercise.
    const command = verifyScript === undefined ? launcherPath : 'node';
    const probeArgs = verifyScript === undefined ? args : [verifyScript, ...args];
    const result = await runCommand(ctx, command, probeArgs, 'capture', launcherEnv(manifest, share, version));
    const output = `${result.stdout}\n${result.stderr}`.trim();
    if (result.error !== undefined || result.status !== 0) {
      throw new InstallError(
        'VERIFY_FAILED',
        `could not run '${launcherName} ${args.join(' ')}' (captured output: ${output || result.error || 'none'}). The downloaded binary cannot execute on this host.`,
      );
    }
    // A tag can carry an upstream version that is not the tag itself; when the
    // user pinned one, the tool has to report it back.
    if (options.version !== undefined && args.includes('--version')) {
      const pattern = new RegExp(`(^|[^0-9.])${version.replaceAll('.', '\\.')}([^0-9.]|$)`);
      if (!pattern.test(output)) {
        throw new InstallError(
          'VERSION_MISMATCH',
          `version check failed: '${launcherName} ${args.join(' ')}' printed '${output}' but the requested release is ${options.version} (expected ${version}). The archive does not match the tag; try another --version.`,
        );
      }
    }
    reported = output;
    ctx.log(`verified ${launcherName} ${args.join(' ')}: ${output}`);
  }
  const entries: Array<[string, string]> = [
    ['tool', manifest.id],
    ['installer', 'decx install'],
    ['install_method', 'release download'],
    ['installed', isoTimestamp()],
    ['release_source', `https://github.com/${release.repository}`],
    ['release_tag', tag],
    ['version', version],
    ['platform', ctx.platform ?? `${process.platform}-${process.arch}`],
    ['release_asset', asset],
  ];
  if (specsAsset !== undefined) {
    entries.push(['specs_asset', specsAsset]);
  }
  entries.push(['checksum', checksum], ['sha256', sha256]);
  if (reported !== '') {
    entries.push(['reported_version', reported]);
  }
  entries.push(['specs_installed', String(specsInstalled)]);
  entries.push(
    ['binary', path.join(binRoot(ctx.home), launcherName)],
    ['binaries', binaries.join(' ')],
    ['bin_dir', binRoot(ctx.home)],
    ['prefix', prefix],
  );
  const entry: LaunchEntry = verifyScript === undefined
    ? { command: path.join(binRoot(ctx.home), launcherName), args: [] }
    : { command: 'node', args: [path.join(prefix, 'app', path.relative(path.join(share, 'app'), verifyScript))] };
  return {
    entry,
    provenance: { ...Object.fromEntries(entries), ...extraProvenance },
    binaries,
    launcherName,
    method: 'release download',
    version,
    releaseTag: tag,
    releaseSource: `https://github.com/${release.repository}`,
    asset,
    ...(specsAsset !== undefined ? { specsAsset } : {}),
    specsInstalled,
    checksum,
  };
}

async function stageVenv(
  ctx: ResolvedContext,
  manifest: ToolManifest,
  prefix: string,
  stage: string,
  options: InstallOptions,
): Promise<StagedOutcome> {
  const packageName = manifest.install[2] as string;
  const provenance: Record<string, string> = {};
  const python = await findPython(ctx, manifest.id, manifest.requires?.python);
  const platformOs = ctx.platform !== null ? ctx.platform.split('-')[0] ?? 'unknown' : isWindows() ? 'win' : process.platform;
  const windows = platformOs === 'win';
  const venvBin = windows ? 'Scripts' : 'bin';
  const venvPythonName = windows ? 'python.exe' : 'python';
  const venvDir = runtimePath(ctx.home, manifest.id);
  fs.mkdirSync(path.join(stage, 'bin'), { recursive: true });
  const name = manifest.launch.commands[0] as string;
  const launcherName = windows ? `${name}.cmd` : name;
  const consoleScript = path.join(venvDir, venvBin, windows ? `${name}.exe` : name);
  const entry: LaunchEntry = { command: windows ? consoleScript : path.join(venvDir, venvBin, venvPythonName),
    args: windows ? [] : [consoleScript], env: { VIRTUAL_ENV: venvDir }, prependPath: path.join(venvDir, venvBin) };
  fs.writeFileSync(path.join(stage, 'bin', launcherName), launcherText(entry, windows));
  applyExecutableMode(path.join(stage, 'bin', launcherName));
  const binaries = [launcherName];
  return {
    entry,
    provenance,
    binaries,
    launcherName,
    method: 'python venv',
    // Console scripts (including Windows .exe launchers) embed the interpreter
    // path. Build the environment here, never in a staging path that will move.
    initialize: async () => {
      ctx.log(`creating virtualenv in ${venvDir} (${platformOs})`);
      const venv = await runCommand(ctx, python.command, [...python.args, '-m', 'venv', venvDir], 'stream');
      if (venv.error !== undefined || venv.status !== 0) {
        throw new InstallError(
          'VENV_FAILED',
          `${python.label} -m venv failed. Make sure the venv module is available (Debian/Ubuntu: 'apt install python3-venv'; macOS: 'brew install python3'; Windows: the python.org build bundles it) and that ${prefix} is writable.`,
        );
      }
      const venvPython = path.join(venvDir, venvBin, venvPythonName);
      if (!isExecutable(venvPython)) {
        throw new InstallError(
          'VENV_LAYOUT',
          `the virtualenv at ${venvDir} does not contain ${venvBin}/${venvPythonName}, which is what platform '${platformOs}' expects. Remove it and retry with a CPython 3 build from python.org or your distribution.`,
        );
      }
      const installArgs = manifest.install.slice(2);
      if (options.version !== undefined && options.version !== 'latest') {
        const requested = options.version.replace(/^v/, '');
        if (!/^[0-9][A-Za-z0-9.!+_-]*$/.test(requested)) {
          throw new InstallError('INVALID_VERSION', `invalid PyPI package version: ${options.version}`);
        }
        const index = installArgs.indexOf(packageName);
        installArgs[index] = `${packageName}==${requested}`;
      }
      ctx.log(`running pip install for ${manifest.id} into ${venvDir}`);
      const install = await runCommand(ctx, venvPython, ['-m', 'pip', 'install', ...installArgs], 'stream');
      if (install.error !== undefined || install.status !== 0) {
        throw new InstallError('PIP_FAILED', `pip install failed. Check the declared install command and Python package dependencies for ${manifest.id}.`);
      }
      const versionResult = await runCommand(ctx, venvPython, ['-c', `import importlib.metadata; print(importlib.metadata.version(${JSON.stringify(packageName)}))`], 'capture');
      const installedVersion = versionResult.stdout.trim();
      if (versionResult.error !== undefined || versionResult.status !== 0 || installedVersion === '') {
        throw new InstallError('PACKAGE_VERSION', `could not determine installed version of ${packageName} in ${venvDir}`);
      }
      if (!isExecutable(consoleScript)) {
        throw new InstallError('ENTRY_MISSING', `${manifest.id} did not install its declared console script: ${consoleScript}`);
      }
      const args = verifyArgs(manifest);
      if (args.length > 0) {
        const result = await runCommand(ctx, consoleScript, args, 'capture');
        if (result.error !== undefined || result.status !== 0) {
          throw new InstallError('VERIFY_FAILED', `${manifest.id} verification failed: ${firstLine(result) || result.error || 'no output'}`);
        }
      }
      const entries: Array<[string, string]> = [
        ['tool', manifest.id],
        ['installer', 'decx install'],
        ['install_method', 'python venv'],
        ['installed', isoTimestamp()],
        ['install_command', ['pip', 'install', ...installArgs].join(' ')],
        ['version', installedVersion],
        ['platform', ctx.platform ?? platformOs],
        ['python', `${python.output} (${python.label})`],
        ['python_manager', 'pip'],
        ['venv', path.join(venvDir, venvBin, venvPythonName)],
        ['binaries', binaries.join(' ')],
        ['bin_dir', binRoot(ctx.home)],
        [
          'launcher',
          `${path.join(binRoot(ctx.home), launcherName)} -> ${consoleScript}`,
        ],
      ];
      Object.assign(provenance, Object.fromEntries(entries));
    },
  };
}

/** Finish layout in staging; the transaction only moves ready-to-install files. */
function stageEnvironment(stage: string, prefix: string, outcome: StagedOutcome, env: Record<string, string>): void {
  const packagedBin = path.join(stage, 'share', outcome.provenance.tool as string, 'bin');
  fs.mkdirSync(packagedBin, { recursive: true });
  const original = outcome.launcherName;
  outcome.entry.command = path.join(prefix, 'bin', original);
  outcome.entry.env = env;
  outcome.binaries = outcome.binaries.map(name => {
    fs.renameSync(path.join(stage, 'bin', name), path.join(packagedBin, name));
    const storeName = launcherStoreName(name);
    const target = path.join(prefix, 'bin', name);
    fs.writeFileSync(path.join(stage, 'bin', storeName), launcherText({ command: target, args: [], env }, isWindows()));
    applyExecutableMode(path.join(stage, 'bin', storeName));
    if (name === original) outcome.launcherName = storeName;
    return storeName;
  });
}

interface CommittedStage {
  bins: string[];
  removed: string[];
}

/**
 * Moves a validated staging tree into the install: executables (or their
 * launchers) into `<home>/bin` (the store every tool shares) and source/data
 * into the payload `<home>/share/<id>`; Python environments live separately
 * under `<home>/runtime/<id>`.  The payload is swapped as a whole, so a
 * failed move restores the previous one; a store file that belongs to another
 * tool is refused unless `force` is set.
 * Backups are retained until finalize has written the complete PROVENANCE.
 */
async function commitStage(
  stage: string,
  home: string,
  id: string,
  force: boolean,
  log: (line: string) => void,
  initialize: () => Promise<void>,
  finalize: (committed: CommittedStage) => void,
  replaceRuntime = false,
): Promise<CommittedStage> {
  const binDir = binRoot(home);
  const payload = toolPrefix(home, id);
  const existingPayload = lstatIfPresent(payload);
  if (existingPayload !== undefined && readProvenance(path.join(payload, 'PROVENANCE'))?.tool !== id) {
    throw new InstallError('PAYLOAD_CONFLICT', `${payload} exists without a valid ${id} PROVENANCE; refusing to replace unrelated files`);
  }
  const previous = provenanceBinaries(readProvenance(path.join(payload, 'PROVENANCE')) ?? {})
    .filter((name) => isSafeRelativePath(name) && !name.includes('/'));
  const stagedBin = path.join(stage, 'bin');
  const names = listDirEntries(stagedBin)
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
  for (const name of names) {
    const target = path.join(binDir, name);
    if (lstatIfPresent(target) !== undefined && !previous.includes(name) && !force) {
      throw new InstallError(
        'BIN_CONFLICT',
        `${target} already exists and is not part of the current ${id} install; installing would shadow another tool`,
        { hint: 'move that file away, or re-run with --force to replace it' },
      );
    }
  }
  fs.mkdirSync(binDir, { recursive: true });
  const stagedShare = path.join(stage, 'share', id);
  if (!fs.existsSync(stagedShare)) {
    throw new InstallError('STAGE_INCOMPLETE', `${stagedShare} is missing; nothing was committed`);
  }
  const backupRoot = fs.mkdtempSync(path.join(home, '.decx-backup-'));
  const backup = path.join(backupRoot, 'payload');
  const runtime = runtimePath(home, id);
  const runtimeBackup = path.join(backupRoot, 'runtime');
  let runtimeSaved = false;
  let runtimeStarted = false;
  const savedBins: string[] = [];
  const writtenBins: string[] = [];
  let payloadSaved = false;
  let payloadInstalled = false;
  let committed: CommittedStage;
  try {
    fs.mkdirSync(path.join(backupRoot, 'bin'));
    if (lstatIfPresent(payload) !== undefined) {
      fs.renameSync(payload, backup);
      payloadSaved = true;
    }
    fs.mkdirSync(path.dirname(payload), { recursive: true });
    fs.renameSync(stagedShare, payload);
    payloadInstalled = true;
    if (replaceRuntime && lstatIfPresent(runtime) !== undefined) {
      fs.renameSync(runtime, runtimeBackup);
      runtimeSaved = true;
    }
    runtimeStarted = replaceRuntime;
    await initialize();
    // Save every overwritten or stale executable before modifying the store.
    for (const name of new Set([...names, ...previous])) {
      const target = path.join(binDir, name);
      if (lstatIfPresent(target) !== undefined) {
        fs.renameSync(target, path.join(backupRoot, 'bin', name));
        savedBins.push(name);
      }
    }
    const bins: string[] = [];
    for (const name of names) {
      writtenBins.push(name);
      fs.renameSync(path.join(stagedBin, name), path.join(binDir, name));
      bins.push(name);
    }
    const removed: string[] = [];
    for (const name of previous) {
      if (bins.includes(name)) {
        continue;
      }
      const stale = path.join(binDir, name);
      if (savedBins.includes(name)) {
        removed.push(name);
        log(`removed stale executable ${stale}`);
      }
    }
    committed = { bins, removed };
    finalize(committed);
  } catch (error) {
    // Keep the backup outside the staging tree if rollback itself fails.
    for (const name of writtenBins) {
      fs.rmSync(path.join(binDir, name), { recursive: true, force: true });
    }
    for (const name of savedBins) {
      fs.renameSync(path.join(backupRoot, 'bin', name), path.join(binDir, name));
    }
    if (payloadInstalled) {
      fs.rmSync(payload, { recursive: true, force: true });
    }
    if (runtimeSaved || runtimeStarted) fs.rmSync(runtime, { recursive: true, force: true });
    if (runtimeSaved) {
      fs.mkdirSync(path.dirname(runtime), { recursive: true });
      fs.renameSync(runtimeBackup, runtime);
    }
    if (payloadSaved) {
      fs.renameSync(backup, payload);
    }
    fs.rmSync(backupRoot, { recursive: true, force: true });
    throw error;
  }
  const foreignBins = savedBins.filter((name) => !previous.includes(name));
  if (foreignBins.length > 0) {
    const retained = fs.mkdtempSync(path.join(home, `.decx-overwritten-${id}-`));
    for (const name of foreignBins) {
      fs.renameSync(path.join(backupRoot, 'bin', name), path.join(retained, name));
      log(`saved overwritten foreign executable in ${path.join(retained, name)}`);
    }
  }
  fs.rmSync(backupRoot, { recursive: true, force: true });
  return committed;
}

/**
 * Installs one tool into `<home>/share/<id>` and returns what landed where.
 * Source staging and preflight checks precede the swap. Python environment
 * initialization runs at the final prefix, protected by the same rollback.
 */
export async function installTool(
  manifest: ToolManifest,
  options: InstallOptions,
  context: InstallContext,
): Promise<InstallResult> {
  const home = assertInstallRoot(context.home);
  const ctx = resolveContext({ ...context, home });
  const prefix = toolPrefix(home, manifest.id);
  const previousRecord = readProvenance(path.join(prefix, 'PROVENANCE'));
  if (lstatIfPresent(prefix) !== undefined && previousRecord?.tool !== manifest.id) {
    throw new InstallError('PAYLOAD_CONFLICT', `${prefix} exists without a valid ${manifest.id} PROVENANCE; refusing to replace unrelated files`);
  }
  if (manifest.launch.type === 'js') {
    const node = await runCommand(ctx, 'node', ['--version']);
    if (node.error !== undefined || node.status !== 0) {
      throw new InstallError('NODE_NOT_FOUND', 'JS tools require Node on PATH; install Node before running decx install');
    }
  }
  fs.mkdirSync(home, { recursive: true });
  // The stage sits in DECX_HOME rather than in the payload (which is swapped as
  // a whole), and the executables it holds are moved into <home>/bin, so every
  // step is a rename on one filesystem.
  const stage = fs.mkdtempSync(path.join(home, '.decx-stage-'));
  const binDir = binRoot(home);
  try {
    const method = manifest.launch.type === 'python' ? 'python venv' : 'release download';
    const release = manifest.release;
    let outcome: StagedOutcome;
    if (method === 'python venv') {
      outcome = await stageVenv(ctx, manifest, prefix, stage, options);
    } else {
      if (release === undefined) throw new InstallError('INVALID_RECIPE', `${manifest.id} needs a binary release`);
      outcome = await stageRelease(ctx, manifest, release, options, prefix, stage, await resolveInstallTag(ctx, release, options));
    }
    const stageShare = path.join(stage, 'share', manifest.id);
    fs.mkdirSync(stageShare, { recursive: true });
    const launcherVariables = launcherEnv(manifest, prefix, outcome.version ?? '');
    if (launcherVariables !== undefined) stageEnvironment(stage, prefix, outcome, launcherVariables);
    const linkDir = resolveLinkDir(options.links, ctx.env);
    let links: LinkOutcome[] = [];
    const storeLauncher = outcome.launcherName;
    let provenance: Record<string, string> = {};
    const committed = await commitStage(stage, home, manifest.id, options.force === true, ctx.log, async () => {
      const initialize = outcome.initialize;
      if (initialize !== undefined) await initialize();
    }, (committed) => {
      provenance = { ...outcome.provenance };
      provenance.binary = path.join(binDir, storeLauncher);
      provenance.binaries = committed.bins.join(' ');
      provenance.bin_dir = binDir;
      if (launcherVariables !== undefined) provenance.env = formatEnv(launcherVariables);
      fs.writeFileSync(path.join(prefix, 'PROVENANCE'), formatProvenance(provenance));
      fs.writeFileSync(path.join(prefix, 'launch.json'), JSON.stringify(outcome.entry));
    }, method === 'python venv');
    // A successful swap may have removed old executable names or moved links to
    // another directory. Prune only exact, previously owned links.
    if (previousRecord?.tool === manifest.id && previousRecord.link_dir !== undefined) {
      for (const name of provenanceBinaries(previousRecord)) {
        if (!isSafeRelativePath(name) || name.includes('/') ||
          (committed.bins.includes(name) && options.noLinks !== true && previousRecord.link_dir === linkDir)) continue;
        try {
          removeManagedLink(previousRecord.link_dir, name, path.join(binDir, name));
        } catch (error) {
          ctx.log(`warning: could not remove stale PATH link for ${name}: ${(error as Error).message}`);
        }
      }
    }
    // PATH integration is best effort, outside the payload/store transaction.
    // Failure here must not turn a successfully committed install into a failure.
    if (options.noLinks !== true) {
      try {
        links = createLinks({ home, files: committed.bins, linkDir, force: options.force === true, log: ctx.log });
        const linked = links.filter((link) => link.status !== 'conflict');
        const linkedProvenance = { ...provenance };
        linkedProvenance.link_dir = linkDir;
        if (linked.length > 0) linkedProvenance.links = linked.map((link) => link.path).join(' ');
        // An atomic replacement leaves the core record valid if recording links fails.
        const record = path.join(stage, 'PROVENANCE.links');
        try {
          fs.writeFileSync(record, formatProvenance(linkedProvenance));
          fs.renameSync(record, path.join(prefix, 'PROVENANCE'));
          provenance = linkedProvenance;
        } finally {
          fs.rmSync(record, { force: true });
        }
      } catch (error) {
        ctx.log(`warning: installed ${manifest.id}, but PATH link setup/recording failed: ${(error as Error).message}`);
      }
    }
    for (const link of links) {
      if (link.status === 'conflict') {
        ctx.log(`warning: ${link.path}: ${link.reason ?? 'could not create the link'}`);
      }
    }
    const pathDir = options.noLinks === true ? binDir : linkDir;
    const result: InstallResult = {
      id: manifest.id,
      method: outcome.method,
      prefix,
      binDir,
      launcher: path.join(binDir, storeLauncher),
      binaries: committed.bins,
      ...((provenance.version ?? outcome.version) !== undefined ? { version: provenance.version ?? outcome.version } : {}),
      ...(outcome.releaseTag !== undefined ? { releaseTag: outcome.releaseTag } : {}),
      ...(outcome.releaseSource !== undefined ? { releaseSource: outcome.releaseSource } : {}),
      ...(outcome.asset !== undefined ? { asset: outcome.asset } : {}),
      ...(outcome.specsAsset !== undefined ? { specsAsset: outcome.specsAsset } : {}),
      ...(outcome.specsInstalled !== undefined ? { specsInstalled: outcome.specsInstalled } : {}),
      ...(outcome.checksum !== undefined ? { checksum: outcome.checksum } : {}),
      provenance,
      pathHint: pathHint(pathDir, isWindows()),
    };
    if (options.noLinks !== true) { result.links = links; result.linkDir = linkDir; }
    ctx.log(`installed ${manifest.id} (${outcome.method})`);
    ctx.log(`  launcher: ${result.launcher}`);
    if (committed.removed.length > 0) {
      ctx.log(`  removed from the store: ${committed.removed.join(', ')}`);
    }
    ctx.log(`  on PATH through ${pathDir}: ${result.pathHint}`);
    return result;
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}
