/**
 * Tool installation.  Every install is a release download: resolve the tag,
 * pick the asset of the host platform, verify and unpack it, stage inside the
 * tool prefix, then commit `bin/`, `share/<id>/` and (for Kuna) `specs/` plus a
 * PROVENANCE record.
 *
 * Nothing here installs a language runtime: missing tools are reported with
 * the command that installs them.  External programs (python) run through a
 * `CommandRunner` so the whole flow is testable offline.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractArchive } from './archive.ts';
import { binRoot, resolveLinkDir, toolPrefix } from './config.ts';
import { createLinks, type LinkOutcome } from './links.ts';
import {
  DEFAULT_API_BASE,
  DEFAULT_DOWNLOAD_BASE,
  DEFAULT_USER_AGENT,
  GithubError,
  downloadAsset,
  githubToken,
  parseChecksums,
  releaseDownloadUrl,
  resolveRelease,
} from './gh.ts';
import { isSafeRelativePath, type PythonSpec, type ReleaseSpec, type ToolManifest } from './manifest.ts';
import { readProvenance } from './inspect.ts';
import { currentPlatformKey, isWindows, type PlatformKey } from './platform.ts';

export type InstallMethod = 'release download' | 'python venv';

export interface CommandSpec {
  command: string;
  args: string[];
  /** `capture` (default) keeps output for the caller; `stream` also forwards it to stderr. */
  mode?: 'capture' | 'stream';
  env?: NodeJS.ProcessEnv;
}

export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

export type CommandRunner = (spec: CommandSpec) => CommandResult | Promise<CommandResult>;

export interface InstallContext {
  /** DECX_HOME root; the tool prefix is `<home>/share/<id>`. */
  home: string;
  /** Repository root holding `subprojects/`; a temp directory works in tests. */
  repoRoot: string;
  env?: NodeJS.ProcessEnv;
  /** Overrides the host platform key (tests use it to pin an asset). */
  platform?: PlatformKey | null;
  apiBase?: string;
  downloadBase?: string;
  /** Runs the manifest `verify` command after staging; defaults to true. */
  verify?: boolean;
  log?: (line: string) => void;
  run?: CommandRunner;
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
  repoRoot: string;
  env: NodeJS.ProcessEnv;
  platform: PlatformKey | null;
  apiBase: string;
  downloadBase: string;
  verify: boolean;
  log: (line: string) => void;
  run: CommandRunner;
}

interface StagedOutcome {
  /** Runs after the payload reaches its permanent path, while backups still exist. */
  initialize?: () => Promise<Record<string, string>>;
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
    repoRoot: context.repoRoot,
    env: context.env ?? process.env,
    platform: context.platform !== undefined ? context.platform : currentPlatformKey(),
    apiBase: context.apiBase ?? DEFAULT_API_BASE,
    downloadBase: context.downloadBase ?? DEFAULT_DOWNLOAD_BASE,
    verify: context.verify !== false,
    log: context.log ?? ((line: string) => process.stderr.write(`${line}\n`)),
    run: context.run ?? defaultRunner,
  };
}

async function defaultRunner(spec: CommandSpec): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(spec.command, spec.args, { env: spec.env ?? process.env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (spec.mode === 'stream') {
        process.stderr.write(chunk);
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      if (spec.mode === 'stream') {
        process.stderr.write(chunk);
      }
    });
    child.on('error', (error) => resolve({ status: null, stdout, stderr, error: error.message }));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

async function runCommand(
  ctx: ResolvedContext,
  command: string,
  args: string[],
  mode: 'capture' | 'stream' = 'capture',
  extraEnv?: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  return await ctx.run({ command, args, mode, env: extraEnv === undefined ? ctx.env : { ...ctx.env, ...extraEnv } });
}

function assertInstallRoot(home: string): string {
  const resolved = path.resolve(home);
  if (resolved === path.parse(resolved).root) {
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

export interface VenvLauncherInput {
  id: string;
  /** `macos`, `linux` or `windows`, for the informative comment only. */
  platformOs: string;
  /** Environment directory inside the payload, e.g. `.venv`. */
  venvDir: string;
  venvBin: string;
  venvPython: string;
  entry: string;
}

/** The POSIX launcher for a python-venv tool: venv python on its upstream entry point. */
export function venvLauncherText(input: VenvLauncherInput): string {
  return [
    '#!/bin/sh',
    `# Generated by decx install -- exec the dedicated venv on upstream ${input.entry}.`,
    '# Arguments are passed through untouched; this is not a DECX command wrapper.',
    `# Platform: ${input.platformOs} (interpreter: ${input.venvDir}/${input.venvBin}/${input.venvPython})`,
    '# The launcher is reached through a PATH symlink, so follow it to find the payload.',
    'self=$0',
    'while [ -L "$self" ]; do',
    '  link=$(readlink "$self")',
    '  case $link in /*) self=$link ;; *) self=$(dirname -- "$self")/$link ;; esac',
    'done',
    'root=$(CDPATH= cd -- "$(dirname -- "$self")/.." && pwd)',
    `export VIRTUAL_ENV="$root/share/${input.id}/${input.venvDir}"`,
    `export PATH="$VIRTUAL_ENV/${input.venvBin}:$PATH"`,
    `export PYTHONPATH="$root/share/${input.id}\${PYTHONPATH:+:$PYTHONPATH}"`,
    `exec "$root/share/${input.id}/${input.venvDir}/${input.venvBin}/${input.venvPython}" "$root/share/${input.id}/${input.entry}" "$@"`,
    '',
  ].join('\n');
}

/** The cmd.exe/PowerShell sibling launcher; `%*` forwards arguments untouched. */
export function venvCmdLauncherText(input: { id: string; venvDir: string; entry: string }): string {
  return [
    '@echo off',
    'rem Generated by decx install -- Windows cmd/PowerShell launcher.',
    'rem Arguments are passed through untouched; this is not a DECX command wrapper.',
    'setlocal DisableDelayedExpansion',
    'set "root=%~dp0.."',
    `set "VIRTUAL_ENV=%root%\\share\\${input.id}\\${input.venvDir}"`,
    'set "PATH=%VIRTUAL_ENV%\\Scripts;%PATH%"',
    `if defined PYTHONPATH (set "PYTHONPATH=%root%\\share\\${input.id};%PYTHONPATH%") else (set "PYTHONPATH=%root%\\share\\${input.id}")`,
    `"%root%\\share\\${input.id}\\${input.venvDir}\\Scripts\\python.exe" "%root%\\share\\${input.id}\\${input.entry}" %*`,
    'exit /b %errorlevel%',
    '',
  ].join('\r\n');
}

/** Single-quoted POSIX word: `'` is the only character that needs escaping. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
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
    resolved[name] = value.replaceAll('{prefix}', prefix).replaceAll('{version}', version);
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

/**
 * POSIX launcher for a tool that needs `env`: the store file exports the
 * variables and execs the packaged binary.  Arguments are passed through
 * untouched -- this is not a DECX command wrapper.
 */
export function envLauncherText(target: string, env: Record<string, string>): string {
  const lines = [
    '#!/bin/sh',
    '# Generated by decx install -- exports the tool environment, then execs the packaged binary.',
    '# Arguments are passed through untouched; this is not a DECX command wrapper.',
  ];
  for (const [name, value] of Object.entries(env)) {
    lines.push(`export ${name}=${shellQuote(value)}`);
  }
  lines.push(`exec ${shellQuote(target)} "$@"`, '');
  return lines.join('\n');
}

/** The cmd.exe/PowerShell sibling of {@link envLauncherText}. */
export function envCmdLauncherText(target: string, env: Record<string, string>): string {
  const lines = [
    '@echo off',
    'rem Generated by decx install -- exports the tool environment, then runs the packaged binary.',
    'rem Arguments are passed through untouched; this is not a DECX command wrapper.',
    'setlocal',
  ];
  for (const [name, value] of Object.entries(env)) {
    lines.push(`set "${name}=${value}"`);
  }
  lines.push(`"${target}" %*`, 'exit /b %errorlevel%', '');
  return lines.join('\r\n');
}

function isoTimestamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function fromEntries(entries: ReadonlyArray<readonly [string, string]>): Record<string, string> {
  const record: Record<string, string> = {};
  for (const [key, value] of entries) {
    record[key] = value;
  }
  return record;
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

function copyTree(source: string, dest: string): void {
  fs.cpSync(source, dest, { recursive: true });
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
  const wanted = manifest.launch ?? manifest.bins?.[0] ?? manifest.id;
  const found = binaries.find((name) => path.parse(name).name === wanted);
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
    const found = { ...candidate, output };
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

/** A uv invocation that can install requirements, when one is on PATH. */
interface UvCandidate {
  command: string;
  args: string[];
  /** Human-readable form for messages and PROVENANCE, e.g. `uv` or `pipx run uv`. */
  label: string;
}

/** `uv` itself first, then the same tool through pipx (a common install without a PATH entry). */
function uvCandidates(): UvCandidate[] {
  return [
    { command: 'uv', args: [], label: 'uv' },
    { command: 'pipx', args: ['run', 'uv'], label: 'pipx run uv' },
  ];
}

/**
 * Finds a uv to install requirements with.  uv is the preferred manager and does
 * not need the venv's own pip bootstrapped; when no uv is on PATH the install
 * falls back to the interpreter's pip, so a machine without uv still works.
 */
async function findUv(ctx: ResolvedContext): Promise<(UvCandidate & { output: string }) | null> {
  for (const candidate of uvCandidates()) {
    const probe = await runCommand(ctx, candidate.command, [...candidate.args, '--version']);
    if (probe.error !== undefined || probe.status !== 0) {
      continue;
    }
    const output = firstLine(probe);
    if (!/^uv \d/.test(output)) {
      continue;
    }
    return { ...candidate, output };
  }
  return null;
}

function initialMethod(manifest: ToolManifest): InstallMethod {
  return manifest.kind === 'python-venv' ? 'python venv' : 'release download';
}

async function resolveInstallTag(ctx: ResolvedContext, release: ReleaseSpec, options: InstallOptions): Promise<string> {
  if (options.version !== undefined && options.version.trim() !== '') {
    return normalizeReleaseTag(options.version, release.tagPrefix);
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

async function verifyChecksum(
  ctx: ResolvedContext,
  release: ReleaseSpec,
  tag: string,
  asset: string,
  actualSha: string,
  downloads: string,
  token: string | undefined,
): Promise<string> {
  const checksumsName = release.checksums?.replaceAll('{version}', releaseVersionFromTag(tag, release.tagPrefix));
  if (checksumsName === undefined || checksumsName === '') {
    return 'not published by the release source';
  }
  const url = releaseDownloadUrl(ctx.downloadBase, release.repository, tag, checksumsName);
  try {
    await downloadAsset(url, path.join(downloads, checksumsName), {
      ...(token !== undefined ? { token } : {}),
      userAgent: DEFAULT_USER_AGENT,
    });
  } catch (error) {
    if (!(error instanceof GithubError) || error.code !== 'DOWNLOAD_FAILED') {
      throw error;
    }
    throw new InstallError('CHECKSUM_DOWNLOAD_FAILED', `could not download required ${checksumsName} for ${tag}: ${error.message}. Refusing to install an unverified asset.`);
  }
  const expected = parseChecksums(fs.readFileSync(path.join(downloads, checksumsName), 'utf8')).get(asset);
  if (expected === undefined) {
    throw new InstallError(
      'CHECKSUM_MISSING',
      `${checksumsName} in release ${tag} has no entry for ${asset}. Refusing to install an unverified asset.`,
      { hint: 'the release and the manifest disagree; pass --version <tag> or report the release' },
    );
  }
  checkDigest(asset, expected, actualSha);
  ctx.log(`checksum verified: ${actualSha}`);
  return `verified (${actualSha})`;
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
  const token = githubToken(ctx.env);
  const downloads = path.join(stage, 'downloads');
  const extract = path.join(stage, 'extract');
  fs.mkdirSync(downloads, { recursive: true });
  fs.mkdirSync(extract, { recursive: true });
  const assetUrl = releaseDownloadUrl(ctx.downloadBase, release.repository, tag, asset);
  const { sha256 } = await downloadRequired(ctx, assetUrl, path.join(downloads, asset));
  const checksum = await verifyChecksum(ctx, release, tag, asset, sha256, downloads, token);
  extractArchive(path.join(downloads, asset), extract);
  let specsAsset: string | undefined;
  const extraProvenance: Record<string, string> = {};
  for (const [key, template] of Object.entries(release.extraAssets ?? {})) {
    const extraName = template.replaceAll('{version}', version);
    const extraUrl = releaseDownloadUrl(ctx.downloadBase, release.repository, tag, extraName);
    const download = await downloadRequired(ctx, extraUrl, path.join(downloads, extraName));
    const extraChecksum = await verifyChecksum(ctx, release, tag, extraName, download.sha256, downloads, token);
    extraProvenance[`${key}_sha256`] = download.sha256;
    extraProvenance[`${key}_checksum`] = extraChecksum;
    extractArchive(path.join(downloads, extraName), extract);
    if (key === 'specs') {
      specsAsset = extraName;
    }
  }
  return { extract, version, asset, sha256, checksum, extraProvenance, ...(specsAsset !== undefined ? { specsAsset } : {}) };
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
  const wantedBins = manifest.bins ?? [];
  const binaries: string[] = [];
  for (const name of wantedBins) {
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
  if (binaries.length === 0) {
    throw new InstallError('ASSET_LAYOUT', `'${asset}' contains no binaries to install`);
  }
  const launcherName = pickLauncher(manifest, binaries);
  let specsInstalled = 0;
  if (specsAsset !== undefined) {
    const specsSource = findSpecsDir(extract);
    if (specsSource === null) {
      throw new InstallError(
        'SPECS_MISSING',
        `the downloaded archives do not contain a specs/ tree with compiled .sla files. Try another --version.`,
      );
    }
    copyTree(specsSource, path.join(stage, 'specs'));
    specsInstalled = countBySuffix(path.join(stage, 'specs'), '.sla');
    if (specsInstalled === 0) {
      throw new InstallError('SPECS_MISSING', 'no .sla files found in the downloaded specs tree; refusing to install an uncompiled tree.');
    }
    ctx.log(`staged ${specsInstalled} compiled .sla files`);
  }
  const launcherPath = path.join(stage, 'bin', launcherName);
  let reported = '';
  const args = verifyArgs(manifest);
  if (ctx.verify && args.length > 0) {
    // The payload is still the stage here, so `{prefix}` has to resolve to the
    // staged tree -- that is the copy the probe is about to exercise.
    const result = await runCommand(ctx, launcherPath, args, 'capture', launcherEnv(manifest, stage, version));
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
  return {
    provenance: { ...fromEntries(entries), ...extraProvenance },
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

interface PythonSource extends Partial<Pick<StagedOutcome, 'version' | 'releaseTag' | 'releaseSource' | 'asset' | 'checksum'>> {
  directory: string;
  provenance: Record<string, string>;
}

/** Release archives may wrap their payload in one enclosing directory. */
function pythonArchiveRoot(extract: string, entry: string): string {
  if (fs.existsSync(path.join(extract, entry))) {
    return extract;
  }
  const children = listDirEntries(extract);
  if (children.length === 1 && children[0]?.isDirectory()) {
    const directory = path.join(extract, children[0].name);
    if (fs.existsSync(path.join(directory, entry))) {
      return directory;
    }
  }
  throw new InstallError('ASSET_LAYOUT', `Python source archive must contain ${entry} at its root or in one enclosing directory`);
}

/** A pinned upstream checkout the superproject vendors for one tool. */
interface LocalCheckout {
  directory: string;
  /** Path relative to the repository root, as PROVENANCE records it. */
  relative: string;
  commit?: string;
  tag?: string;
  dirty: boolean;
  clean?: boolean;
}

/**
 * The checkout a python tool builds from, when the repository has one:
 * `subprojects/decx-<id>/source` (or `subprojects/<id>/source`), tracked by the
 * superproject as a gitlink.  A directory the submodule was never initialised
 * into is not a checkout, so both files the payload is built from must be there.
 */
function localCheckout(ctx: ResolvedContext, manifest: ToolManifest, spec: PythonSpec): LocalCheckout | null {
  for (const name of [`decx-${manifest.id}`, manifest.id]) {
    const directory = path.join(ctx.repoRoot, 'subprojects', name, 'source');
    if (!fs.existsSync(path.join(directory, spec.entry)) || !fs.existsSync(path.join(directory, spec.requirements))) {
      continue;
    }
    let parent = ctx.repoRoot;
    for (const component of ['subprojects', name, 'source']) {
      parent = path.join(parent, component);
      if (fs.lstatSync(parent).isSymbolicLink()) {
        throw new InstallError('UNSAFE_PYTHON_PATH', `Python checkout must not traverse symlinks: ${parent}`);
      }
    }
    return { directory, relative: path.join('subprojects', name, 'source'), dirty: false };
  }
  return null;
}

/**
 * Best-effort git facts about a checkout: a machine without git still installs,
 * it just records less.  The commit is the revision the payload was actually
 * built from -- which is what PROVENANCE must carry, not the gitlink.
 */
async function checkoutRevision(ctx: ResolvedContext, checkout: LocalCheckout): Promise<LocalCheckout> {
  const git = async (args: string[]): Promise<string | null> => {
    const result = await runCommand(ctx, 'git', ['-C', checkout.directory, ...args]);
    if (result.error !== undefined || result.status !== 0) {
      return null;
    }
    return result.stdout.trim();
  };
  const commit = await git(['rev-parse', 'HEAD']);
  const tag = await git(['describe', '--tags', '--exact-match', 'HEAD']);
  const status = await git(['status', '--porcelain']);
  return {
    ...checkout,
    ...(commit !== null && commit !== '' ? { commit } : {}),
    ...(tag !== null && tag !== '' ? { tag } : {}),
    dirty: status !== null && status !== '',
    clean: status === '',
  };
}

/**
 * The payload a venv install builds from: the pinned checkout the superproject
 * vendors when it is there, otherwise the release's source archive.  The
 * checkout is the revision the subproject's own workflow validates; the archive
 * is the fallback for an install that has no repository at hand.
 */
async function pythonSource(
  ctx: ResolvedContext,
  manifest: ToolManifest,
  release: ReleaseSpec,
  stage: string,
  options: InstallOptions,
): Promise<PythonSource> {
  const spec = manifest.python;
  if (spec === undefined) {
    throw new InstallError('NO_PYTHON_PAYLOAD', `${manifest.id} has no python block describing its payload`);
  }
  for (const item of [spec.entry, spec.requirements, ...spec.payload, spec.venv]) {
    if (!isSafeRelativePath(item) || (item === spec.venv && item.includes('/'))) {
      throw new InstallError('UNSAFE_PYTHON_PATH', `unsafe Python payload path: ${item}`);
    }
  }
  const found = localCheckout(ctx, manifest, spec);
  if (found !== null) {
    const checkout = await checkoutRevision(ctx, found);
    if (options.version !== undefined && (
      checkout.commit === undefined || checkout.tag === undefined || checkout.clean !== true ||
      ![options.version.trim(), normalizeReleaseTag(options.version), normalizeReleaseTag(options.version, release.tagPrefix)].includes(checkout.tag)
    )) {
      throw new InstallError('VERSION_MISMATCH', `--version ${options.version} does not identify the clean checkout at ${checkout.relative} (tag: ${checkout.tag ?? 'unknown'}). Use a checkout at the requested tag or install without the local checkout.`);
    }
    const version = checkout.tag !== undefined ? releaseVersionFromTag(checkout.tag, release.tagPrefix) : undefined;
    ctx.log(`building ${manifest.id} from ${checkout.relative}${checkout.commit !== undefined ? ` (${checkout.commit.slice(0, 7)})` : ''}`);
    if (checkout.dirty) {
      ctx.log(`warning: ${checkout.relative} has uncommitted changes; the install records what is there, not the pinned revision`);
    }
    return {
      directory: checkout.directory,
      ...(version !== undefined ? { version } : {}),
      ...(checkout.tag !== undefined ? { releaseTag: checkout.tag } : {}),
      provenance: {
        source: checkout.relative,
        ...(checkout.commit !== undefined ? { source_commit: checkout.commit } : {}),
        ...(checkout.tag !== undefined ? { source_tag: checkout.tag } : {}),
        ...(checkout.dirty ? { source_dirty: 'true' } : {}),
        ...(version !== undefined ? { version } : {}),
      },
    };
  }
  const tag = await resolveInstallTag(ctx, release, options);
  const downloaded = await downloadRelease(ctx, release, stage, tag);
  const releaseSource = `https://github.com/${release.repository}`;
  return {
    directory: pythonArchiveRoot(downloaded.extract, spec.entry),
    version: downloaded.version,
    releaseTag: tag,
    releaseSource,
    asset: downloaded.asset,
    checksum: downloaded.checksum,
    provenance: {
      release_source: releaseSource,
      release_tag: tag,
      release_asset: downloaded.asset,
      version: downloaded.version,
      sha256: downloaded.sha256,
      checksum: downloaded.checksum,
      ...downloaded.extraProvenance,
    },
  };
}

/** Refuse links, including linked parent directories, before copying Python payloads. */
function copyPythonPath(source: string, payload: string, item: string): void {
  if (!isSafeRelativePath(item)) {
    throw new InstallError('UNSAFE_PYTHON_PATH', `unsafe Python payload path: ${item}`);
  }
  let from = source;
  for (const part of item.split('/')) {
    from = path.join(from, part);
    if (fs.lstatSync(from).isSymbolicLink()) {
      throw new InstallError('UNSAFE_PYTHON_PATH', `Python payload must not contain symlinks: ${from}`);
    }
  }
  const dest = path.join(payload, item);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(from, dest, {
    recursive: true,
    filter: (file) => {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() && !stat.isDirectory()) {
        throw new InstallError('UNSAFE_PYTHON_PATH', `Python payload must contain only regular files and directories: ${file}`);
      }
      return true;
    },
  });
}

async function stageVenv(
  ctx: ResolvedContext,
  manifest: ToolManifest,
  prefix: string,
  stage: string,
  source: PythonSource,
): Promise<StagedOutcome> {
  const spec = manifest.python;
  if (spec === undefined) {
    throw new InstallError('NO_PYTHON_PAYLOAD', `${manifest.id} has no python block describing its payload`);
  }
  const { directory: sourceDir, provenance: sourceProvenance, ...sourceMetadata } = source;
  const entry = path.join(sourceDir, spec.entry);
  if (!fs.existsSync(entry)) {
    throw new InstallError('SOURCE_MISSING', `${manifest.id} entry point not found: ${entry} -- the release payload is not a ${manifest.id} source tree`);
  }
  const requirements = path.join(sourceDir, spec.requirements);
  if (!fs.existsSync(requirements)) {
    throw new InstallError('SOURCE_MISSING', `${manifest.id} requirements not found: ${requirements} -- the release payload is not a ${manifest.id} source tree`);
  }
  const python = await findPython(ctx, manifest.id, manifest.requires?.python);
  const platformOs = ctx.platform !== null ? ctx.platform.split('-')[0] ?? 'unknown' : isWindows() ? 'win' : process.platform;
  const windows = platformOs === 'win';
  const venvBin = windows ? 'Scripts' : 'bin';
  const venvPythonName = windows ? 'python.exe' : 'python';
  const payload = path.join(stage, 'share', manifest.id);
  fs.mkdirSync(payload, { recursive: true });
  for (const item of spec.payload) {
    const from = path.join(sourceDir, item);
    if (!fs.existsSync(from)) {
      throw new InstallError('SOURCE_MISSING', `${manifest.id} payload ${from} not found -- the release payload is not a ${manifest.id} source tree`);
    }
    copyPythonPath(sourceDir, payload, item);
  }
  copyPythonPath(sourceDir, payload, spec.entry);
  for (const optional of [spec.requirements, 'LICENSE', 'README.md']) {
    const from = path.join(sourceDir, optional);
    if (fs.existsSync(from) && !fs.existsSync(path.join(payload, optional))) {
      copyPythonPath(sourceDir, payload, optional);
    }
  }
  const venvName = spec.venv;
  const venvDir = path.join(prefix, venvName);
  if (fs.existsSync(path.join(payload, venvName))) {
    throw new InstallError(
      'VENV_EXISTS',
      `refusing to reuse the environment shipped in the payload: ${manifest.id} installs into a fresh ${venvName} every time.`,
      { hint: `remove ${venvName} from the source payload and run \`decx install ${manifest.id}\` again` },
    );
  }
  fs.mkdirSync(path.join(stage, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(stage, 'bin', manifest.id), venvLauncherText({ id: manifest.id, platformOs, venvDir: venvName, venvBin, venvPython: venvPythonName, entry: spec.entry }));
  applyExecutableMode(path.join(stage, 'bin', manifest.id));
  const binaries = windows ? [manifest.id, `${manifest.id}.cmd`] : [manifest.id];
  let launcherName = manifest.id;
  if (windows) {
    launcherName = `${manifest.id}.cmd`;
    fs.writeFileSync(path.join(stage, 'bin', launcherName), venvCmdLauncherText({ id: manifest.id, venvDir: venvName, entry: spec.entry }));
  }
  return {
    provenance: sourceProvenance,
    binaries,
    launcherName,
    method: 'python venv',
    ...sourceMetadata,
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
      const requirementsPath = path.join(prefix, spec.requirements);
      const uv = await findUv(ctx);
      ctx.log(`installing upstream requirements into ${venvName}${uv !== null ? ` with ${uv.label}` : ' with pip'}`);
      const install =
        uv !== null
          ? await runCommand(ctx, uv.command, [...uv.args, 'pip', 'install', '--python', venvPython, '-r', requirementsPath], 'stream')
          : await runCommand(ctx, venvPython, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', requirementsPath], 'stream');
      if (install.error !== undefined || install.status !== 0) {
        throw new InstallError(
          uv !== null ? 'UV_FAILED' : 'PIP_FAILED',
          `${uv !== null ? `${uv.label} pip install` : 'pip install'} failed. A network connection to PyPI is required; check ${requirements}.`,
        );
      }
      const args = verifyArgs(manifest);
      if (ctx.verify && args.length > 0) {
        const separator = windows ? ';' : ':';
        const result = await runCommand(ctx, venvPython, [path.join(prefix, spec.entry), ...args], 'capture', {
          VIRTUAL_ENV: venvDir,
          PATH: `${path.join(venvDir, venvBin)}${separator}${ctx.env.PATH ?? ''}`,
          PYTHONPATH: `${prefix}${ctx.env.PYTHONPATH ? `${separator}${ctx.env.PYTHONPATH}` : ''}`,
        });
        if (result.error !== undefined || result.status !== 0) {
          throw new InstallError('VERIFY_FAILED', `${manifest.id} verification failed: ${firstLine(result) || result.error || 'no output'}`);
        }
      }
      const entries: Array<[string, string]> = [
        ['tool', manifest.id],
        ['installer', 'decx install'],
        ['install_method', 'python venv'],
        ['installed', isoTimestamp()],
        ['requirements', fs.readFileSync(requirementsPath, 'utf8').trim()],
        ['platform', ctx.platform ?? platformOs],
        ['python', `${python.output} (${python.label})`],
        ['python_manager', uv !== null ? `${uv.label} ${firstVersion(uv.output) ?? ''}`.trim() : 'pip'],
        ['venv', path.join(prefix, venvName, venvBin, venvPythonName)],
        ['binaries', binaries.join(' ')],
        ['bin_dir', binRoot(ctx.home)],
        [
          'launcher',
          `${path.join(binRoot(ctx.home), launcherName)} -> ${path.join(prefix, spec.entry)}`,
        ],
      ];
      return fromEntries(entries);
    },
  };
}

/** Binary file names the previous install recorded, for pruning the store. */
function recordedBinaries(payload: string): string[] {
  const provenance = readProvenance(path.join(payload, 'PROVENANCE'));
  if (provenance === null) {
    return [];
  }
  const list = provenance.binaries;
  if (list !== undefined && list.trim() !== '') {
    return list.split(/\s+/).filter((name) => name !== '');
  }
  const single = provenance.binary;
  return single !== undefined && single.trim() !== '' ? [path.basename(single.trim())] : [];
}

/** A tool whose manifest declares `env` gets launchers instead of bare binaries. */
export interface LauncherWrap {
  /** Variables every launcher exports, `{prefix}`/`{version}` already resolved. */
  env: Record<string, string>;
  /** Staged name of the binary the launchers must run (from `pickLauncher`). */
  launcher: string;
}

interface CommittedStage {
  bins: string[];
  removed: string[];
  launcher?: string;
}

/**
 * Moves a validated staging tree into the install: executables (or their
 * launchers) into `<home>/bin` (the store every tool shares) and everything else
 * into the payload `<home>/share/<id>`.  The payload is swapped as a whole, so a
 * failed move restores the previous one; a store file that belongs to another
 * tool is refused unless `force` is set.  With `wrap` the packaged binaries stay
 * in the payload (`<payload>/bin`) and the store holds launcher scripts that
 * export the manifest environment first.
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
  wrap?: LauncherWrap,
): Promise<CommittedStage> {
  const binDir = binRoot(home);
  const payload = toolPrefix(home, id);
  const previous = recordedBinaries(payload).filter((name) => isSafeRelativePath(name) && !name.includes('/'));
  const stagedBin = path.join(stage, 'bin');
  const names = listDirEntries(stagedBin)
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
  const storeNames = names.map((name) => (wrap === undefined ? name : launcherStoreName(name)));
  for (const name of storeNames) {
    const target = path.join(binDir, name);
    if (fs.lstatSync(target, { throwIfNoEntry: false }) !== undefined && !previous.includes(name) && !force) {
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
  const savedBins: string[] = [];
  const writtenBins: string[] = [];
  let payloadSaved = false;
  let payloadInstalled = false;
  let committed: CommittedStage;
  try {
    fs.mkdirSync(path.join(backupRoot, 'bin'));
    if (fs.lstatSync(payload, { throwIfNoEntry: false }) !== undefined) {
      fs.renameSync(payload, backup);
      payloadSaved = true;
    }
    fs.mkdirSync(path.dirname(payload), { recursive: true });
    fs.renameSync(stagedShare, payload);
    payloadInstalled = true;
    const stagedSpecs = path.join(stage, 'specs');
    if (fs.existsSync(stagedSpecs)) {
      fs.renameSync(stagedSpecs, path.join(payload, 'specs'));
    }
    await initialize();
    // Save every overwritten or stale executable before modifying the store.
    for (const name of new Set([...storeNames, ...previous])) {
      const target = path.join(binDir, name);
      if (fs.lstatSync(target, { throwIfNoEntry: false }) !== undefined) {
        fs.renameSync(target, path.join(backupRoot, 'bin', name));
        savedBins.push(name);
      }
    }
    const packagedBin = path.join(payload, 'bin');
    if (wrap !== undefined) {
      fs.mkdirSync(packagedBin, { recursive: true });
    }
    const bins: string[] = [];
    let launcher: string | undefined;
    for (const [index, name] of names.entries()) {
      const storeName = storeNames[index] ?? name;
      const target = path.join(binDir, storeName);
      writtenBins.push(storeName);
      if (wrap === undefined) {
        fs.copyFileSync(path.join(stagedBin, name), target);
        applyExecutableMode(target);
      } else {
        const packaged = path.join(packagedBin, name);
        fs.renameSync(path.join(stagedBin, name), packaged);
        if (storeName.endsWith('.cmd')) {
          fs.writeFileSync(target, envCmdLauncherText(packaged, wrap.env));
        } else {
          fs.writeFileSync(target, envLauncherText(packaged, wrap.env));
          applyExecutableMode(target);
        }
        if (name === wrap.launcher) {
          launcher = storeName;
        }
      }
      bins.push(storeName);
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
    committed = { bins, removed, ...(launcher !== undefined ? { launcher } : {}) };
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
    if (payloadSaved) {
      fs.renameSync(backup, payload);
    }
    fs.rmSync(backupRoot, { recursive: true, force: true });
    throw error;
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
  fs.mkdirSync(home, { recursive: true });
  // The stage sits in DECX_HOME rather than in the payload (which is swapped as
  // a whole), and the executables it holds are moved into <home>/bin, so every
  // step is a rename on one filesystem.
  const stage = fs.mkdtempSync(path.join(home, '.decx-stage-'));
  const binDir = binRoot(home);
  try {
    const method = initialMethod(manifest);
    const release = manifest.release;
    let outcome: StagedOutcome;
    if (method === 'python venv') {
      // A venv install builds from the vendored checkout when there is one, so
      // only the download fallback needs a release tag resolved.
      outcome = await stageVenv(ctx, manifest, prefix, stage, await pythonSource(ctx, manifest, release, stage, options));
    } else {
      outcome = await stageRelease(ctx, manifest, release, options, prefix, stage, await resolveInstallTag(ctx, release, options));
    }
    const stageShare = path.join(stage, 'share', manifest.id);
    fs.mkdirSync(stageShare, { recursive: true });
    fs.writeFileSync(path.join(stageShare, 'PROVENANCE'), formatProvenance(outcome.provenance));
    // A manifest that declares `env` is installed as launcher wrappers: the
    // packaged binaries move into the payload and `<home>/bin` holds scripts that
    // export the variables first, so the tool finds its own data without any
    // shell configuration.
    const launcherVariables = launcherEnv(manifest, prefix, outcome.version ?? '');
    const wrap =
      launcherVariables === undefined ? undefined : { env: launcherVariables, launcher: outcome.launcherName };
    const linkDir = resolveLinkDir(options.links, ctx.env);
    let links: LinkOutcome[] = [];
    let storeLauncher = outcome.launcherName;
    let provenance: Record<string, string> = {};
    const committed = await commitStage(stage, home, manifest.id, options.force === true, ctx.log, async () => {
      if (outcome.initialize !== undefined) {
        outcome.provenance = { ...outcome.provenance, ...await outcome.initialize() };
      }
    }, (committed) => {
      storeLauncher = committed.launcher ?? outcome.launcherName;
      provenance = {
        ...outcome.provenance,
        binary: path.join(binDir, storeLauncher),
        binaries: committed.bins.join(' '),
        bin_dir: binDir,
        ...(launcherVariables !== undefined ? { env: formatEnv(launcherVariables) } : {}),
      };
      fs.writeFileSync(path.join(prefix, 'PROVENANCE'), formatProvenance(provenance));
    }, wrap);
    // PATH integration is best effort, outside the payload/store transaction.
    // Failure here must not turn a successfully committed install into a failure.
    if (options.noLinks !== true) {
      try {
        links = createLinks({ home, files: committed.bins, linkDir, force: options.force === true, log: ctx.log });
        const linked = links.filter((link) => link.status !== 'conflict');
        const linkedProvenance = {
          ...provenance,
          link_dir: linkDir,
          ...(linked.length > 0 ? { links: linked.map((link) => link.path).join(' ') } : {}),
        };
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
      ...(outcome.version !== undefined ? { version: outcome.version } : {}),
      ...(outcome.releaseTag !== undefined ? { releaseTag: outcome.releaseTag } : {}),
      ...(outcome.releaseSource !== undefined ? { releaseSource: outcome.releaseSource } : {}),
      ...(outcome.asset !== undefined ? { asset: outcome.asset } : {}),
      ...(outcome.specsAsset !== undefined ? { specsAsset: outcome.specsAsset } : {}),
      ...(outcome.specsInstalled !== undefined ? { specsInstalled: outcome.specsInstalled } : {}),
      ...(outcome.checksum !== undefined ? { checksum: outcome.checksum } : {}),
      provenance,
      pathHint: pathHint(pathDir, isWindows()),
      ...(options.noLinks === true ? {} : { links, linkDir }),
    };
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
