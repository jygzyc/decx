/**
 * Tool installation.  This is the Node replacement for the earlier bash installers
 * (`scripts/install-*.sh`, since removed): resolve the release or source build for
 * the host platform, download and verify, stage inside the tool prefix, then commit
 * `bin/`, `share/<id>/` and (for Kuna) `specs/` plus a PROVENANCE record whose layout
 * and keys match the ones those scripts wrote.
 *
 * Nothing here installs a language runtime: missing tools are reported with
 * the command that installs them.  External programs (cargo, python, git) run
 * through a `CommandRunner` so the whole flow is testable offline.
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
import type { ReleaseSpec, ToolManifest } from './manifest.ts';
import { readProvenance } from './inspect.ts';
import { currentPlatformKey, isWindows, type PlatformKey } from './platform.ts';

export type InstallMethod = 'release download' | 'source build' | 'python venv';

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
  /** Explicit release tag; `1.508` and `tools-v0.1.0` are normalised. */
  version?: string;
  fromSource?: boolean;
  /** Checkout to build instead of the manifest's default path (implies --from-source). */
  source?: string;
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

async function gitOutput(ctx: ResolvedContext, args: string[]): Promise<string | undefined> {
  const result = await runCommand(ctx, 'git', args);
  if (result.error !== undefined || result.status !== 0) {
    return undefined;
  }
  const value = result.stdout.trim();
  return value === '' ? undefined : value;
}

/**
 * The gitlink a submodule path records in the superproject.  HEAD is what a
 * committed tree carries; before the submodule move is committed the gitlink
 * only exists in the index, so that is the fallback.
 */
async function gitlinkRevision(ctx: ResolvedContext, sourcePath: string): Promise<string> {
  for (const ref of [`HEAD:${sourcePath}`, `:${sourcePath}`]) {
    const value = await gitOutput(ctx, ['-C', ctx.repoRoot, 'rev-parse', '--verify', '--quiet', ref]);
    if (value !== undefined) {
      return value;
    }
  }
  return 'unknown';
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

/** The asset for one platform with `{version}` substituted, or null. */
export function releaseAssetName(release: ReleaseSpec, platform: PlatformKey | null, version: string): string | null {
  const template = (platform === null ? undefined : release.assets[platform]) ?? release.assets.any;
  return template === undefined ? null : template.replaceAll('{version}', version);
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
    `# Platform: ${input.platformOs} (interpreter: venv/${input.venvBin}/${input.venvPython})`,
    '# The launcher is reached through a PATH symlink, so follow it to find the payload.',
    'self=$0',
    'while [ -L "$self" ]; do',
    '  link=$(readlink "$self")',
    '  case $link in /*) self=$link ;; *) self=$(dirname -- "$self")/$link ;; esac',
    'done',
    'root=$(CDPATH= cd -- "$(dirname -- "$self")/.." && pwd)',
    `exec "$root/share/${input.id}/venv/${input.venvBin}/${input.venvPython}" "$root/share/${input.id}/${input.entry}" "$@"`,
    '',
  ].join('\n');
}

/** The cmd.exe/PowerShell sibling launcher; `%*` forwards arguments untouched. */
export function venvCmdLauncherText(input: { id: string; entry: string }): string {
  return [
    '@echo off',
    'rem Generated by decx install -- Windows cmd/PowerShell launcher.',
    'rem Arguments are passed through untouched; this is not a DECX command wrapper.',
    'setlocal',
    'set "root=%~dp0.."',
    `"%root%\\share\\${input.id}\\venv\\Scripts\\python.exe" "%root%\\share\\${input.id}\\${input.entry}" %*`,
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

/**
 * `--from-source` is only a way out for tools whose manifest ships a buildable
 * checkout; a release-only tool gets no such hint. The clause and the hint entry
 * are two shapes because one lands inside a sentence, the other replaces an entry.
 */
function fromSourceClause(manifest: ToolManifest, text: string): string {
  return manifest.source?.build === undefined ? '' : text;
}

function fromSourceHint(manifest: ToolManifest, text: string): { hint?: string } {
  return manifest.source?.build === undefined ? {} : { hint: text };
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

function readFirstLine(file: string): string | undefined {
  try {
    const line = fs.readFileSync(file, 'utf8').split(/\r?\n/)[0]?.trim();
    return line === undefined || line === '' ? undefined : line;
  } catch {
    return undefined;
  }
}

/** First `version = "..."` in the `[package]` section; workspace inherits are `unknown`. */
export function readPackageVersion(manifestFile: string): string {
  let text: string;
  try {
    text = fs.readFileSync(manifestFile, 'utf8');
  } catch {
    return 'unknown';
  }
  let inPackage = false;
  for (const line of text.split(/\r?\n/)) {
    const section = /^\s*\[([^\]]+)\]/.exec(line);
    if (section !== null) {
      inPackage = (section[1] as string).trim() === 'package';
      continue;
    }
    if (!inPackage) {
      continue;
    }
    const match = /^\s*version\s*=\s*"([^"]*)"/.exec(line);
    if (match !== null) {
      const value = (match[1] as string).trim();
      return value === '' || value.includes('workspace') ? 'unknown' : value;
    }
  }
  return 'unknown';
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
  try {
    fs.chmodSync(file, 0o755);
  } catch {
    // filesystems without POSIX modes; the file content is what matters
  }
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
  const wanted = manifest.launch?.bin ?? manifest.id;
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

async function requireRust(
  ctx: ResolvedContext,
  id: string,
  requirement: string | undefined,
): Promise<{ version: string; rustc: string; cargo: string }> {
  const cargoProbe = await runCommand(ctx, 'cargo', ['--version']);
  if (cargoProbe.error !== undefined || cargoProbe.status !== 0) {
    throw new InstallError(
      'CARGO_NOT_FOUND',
      "cargo not found in PATH. Install the Rust toolchain (https://rustup.rs, or 'apt install cargo rustc') and re-run; decx does not install it for you.",
    );
  }
  const rustcProbe = await runCommand(ctx, 'rustc', ['--version']);
  if (rustcProbe.error !== undefined || rustcProbe.status !== 0) {
    throw new InstallError(
      'RUSTC_NOT_FOUND',
      'rustc not found in PATH. Install the Rust toolchain (https://rustup.rs) and re-run; decx does not install it for you.',
    );
  }
  const output = firstLine(rustcProbe);
  const version = firstVersion(output);
  if (version === undefined) {
    throw new InstallError('RUSTC_UNKNOWN', `could not parse 'rustc --version' output: ${output}`);
  }
  if (requirement !== undefined && !meetsRequirement(version, requirement)) {
    throw new InstallError(
      'RUSTC_TOO_OLD',
      `rustc ${version} is too old: ${id} requires rust ${requirement}. Update the toolchain ('rustup update stable') and re-run; decx does not install it for you.`,
    );
  }
  return { version, rustc: output, cargo: firstLine(cargoProbe) };
}

async function optionalRust(ctx: ResolvedContext): Promise<{ rustc: string; cargo: string } | null> {
  const rustc = await runCommand(ctx, 'rustc', ['--version']);
  if (rustc.error !== undefined || rustc.status !== 0) {
    return null;
  }
  const cargo = await runCommand(ctx, 'cargo', ['--version']);
  if (cargo.error !== undefined || cargo.status !== 0) {
    return null;
  }
  return { rustc: firstLine(rustc), cargo: firstLine(cargo) };
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
function pythonCandidates(): PythonCandidate[] {
  // An explicit `DECX_PYTHON` is used as given: the caller knows the machine.
  const override = (process.env.DECX_PYTHON ?? '').trim();
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
  for (const candidate of pythonCandidates()) {
    const probe = await runCommand(ctx, candidate.command, [...candidate.args, '--version']);
    if (probe.error !== undefined) {
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

function validateInstallOptions(manifest: ToolManifest, options: InstallOptions): void {
  const wantsSource = options.fromSource === true || (options.source !== undefined && options.source !== '');
  if (manifest.kind === 'python-venv') {
    if (wantsSource) {
      throw new InstallError('USAGE', `${manifest.id} installs from its Python checkout; --from-source and --source do not apply`, {
        exitCode: 2,
      });
    }
    if (options.version !== undefined) {
      throw new InstallError('USAGE', `--version applies to release downloads; ${manifest.id} has no release to download`, {
        exitCode: 2,
      });
    }
    return;
  }
  if (wantsSource && options.version !== undefined) {
    throw new InstallError(
      'USAGE',
      "--version only applies to the release download path; --from-source builds the checkout's current revision",
      { exitCode: 2 },
    );
  }
}

function initialMethod(manifest: ToolManifest, options: InstallOptions): InstallMethod {
  if (manifest.kind === 'python-venv') {
    return 'python venv';
  }
  if (options.fromSource === true || (options.source !== undefined && options.source !== '')) {
    return 'source build';
  }
  return manifest.release !== undefined ? 'release download' : 'source build';
}

async function resolveInstallTag(
  ctx: ResolvedContext,
  manifest: ToolManifest,
  release: ReleaseSpec,
  options: InstallOptions,
): Promise<string> {
  if (options.version !== undefined && options.version.trim() !== '') {
    return options.version === release.tag ? release.tag : normalizeReleaseTag(options.version, release.tagPrefix);
  }
  if (release.tag !== undefined) {
    return release.tag;
  }
  const pinned =
    release.version !== undefined && release.version.trim() !== ''
      ? normalizeReleaseTag(release.version, release.tagPrefix)
      : undefined;
  // A pinned manifest is the version whose asset names were verified, so it is
  // what `decx install <id>` reproduces.
  if (pinned !== undefined) {
    return pinned;
  }
  try {
    const token = githubToken(ctx.env);
    const resolved = await resolveRelease({
      repository: release.repository,
      ...(release.tagPrefix !== undefined ? { tagPrefix: release.tagPrefix } : {}),
      ...(token !== undefined ? { token } : {}),
      apiBase: ctx.apiBase,
      userAgent: DEFAULT_USER_AGENT,
    });
    return resolved.tag;
  } catch (error) {
    throw new InstallError('RELEASE_RESOLVE_FAILED', `could not resolve a release of ${release.repository}: ${(error as Error).message}`, {
      hint: `pass --version <tag> to pick a release explicitly${fromSourceClause(manifest, ', or use --from-source')}`,
    });
  }
}

/** Only transport/availability errors may select another source. All checks fail closed. */
function sourceUnavailable(error: unknown): error is InstallError {
  return error instanceof InstallError && ['DOWNLOAD_FAILED', 'RELEASE_RESOLVE_FAILED', 'UNSUPPORTED_PLATFORM', 'SOURCE_MISSING'].includes(error.code);
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

/** An exact bundle tag can carry a differently versioned upstream tool. */
function releaseToolVersion(release: ReleaseSpec, tag: string): string {
  return tag === release.tag && release.version !== undefined
    ? release.version
    : releaseVersionFromTag(tag, release.tagPrefix);
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
  const checksumsName = release.checksums?.replaceAll('{version}', releaseToolVersion(release, tag));
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
    ctx.log(`warning: ${checksumsName} not found in release ${tag}; relying on the functional check`);
    return `not verified (${checksumsName} not found)`;
  }
  const expected = parseChecksums(fs.readFileSync(path.join(downloads, checksumsName), 'utf8')).get(asset);
  if (expected === undefined) {
    ctx.log(`warning: no ${asset} entry in ${checksumsName}; relying on the functional check`);
    return `not verified (no entry in ${checksumsName})`;
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

/** The same checked release transport serves binaries and Python source payloads. */
async function downloadRelease(
  ctx: ResolvedContext,
  manifest: ToolManifest,
  release: ReleaseSpec,
  stage: string,
  tag: string,
): Promise<ReleaseArchive> {
  const version = releaseToolVersion(release, tag);
  const asset = releaseAssetName(release, ctx.platform, version);
  if (asset === null) {
    throw new InstallError('UNSUPPORTED_PLATFORM', `no archive is defined for this platform (${ctx.platform ?? `${process.platform}-${process.arch}`})`, {
      ...fromSourceHint(manifest, 'use --from-source to build from a checkout'),
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
  const { extract, version, asset, sha256, checksum, specsAsset, extraProvenance } = await downloadRelease(ctx, manifest, release, stage, tag);
  const wantedBins = manifest.bins ?? [];
  const binaries: string[] = [];
  for (const name of wantedBins) {
    const found = findFile(extract, [name, `${name}.exe`]);
    if (found === null) {
      throw new InstallError(
        'ASSET_LAYOUT',
        `'${asset}' does not contain '${name}' (or '${name}.exe'). The release layout may have changed; try another --version${fromSourceClause(manifest, ', or use --from-source')}.`,
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
        `the downloaded archives do not contain a specs/ tree with compiled .sla files. Try another --version${fromSourceClause(manifest, ', or use --from-source if you need to compile the specs yourself')}.`,
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
  if (ctx.verify && manifest.verify !== undefined && manifest.verify.args.length > 0) {
    const args = manifest.verify.args;
    // The payload is still the stage here, so `{prefix}` has to resolve to the
    // staged tree -- that is the copy the probe is about to exercise.
    const result = await runCommand(ctx, launcherPath, args, 'capture', launcherEnv(manifest, stage, version));
    const output = `${result.stdout}\n${result.stderr}`.trim();
    if (result.error !== undefined || result.status !== 0) {
      throw new InstallError(
        'VERIFY_FAILED',
        `could not run '${launcherName} ${args.join(' ')}' (captured output: ${output || result.error || 'none'}). The downloaded binary cannot execute on this host${fromSourceClause(manifest, '; use --from-source to build the checkout instead')}.`,
      );
    }
    if (release.tagPrefix === undefined && options.version !== undefined) {
      const pattern = new RegExp(`(^|[^0-9.])${version.replaceAll('.', '\\.')}([^0-9.]|$)`);
      if (!pattern.test(output)) {
        throw new InstallError(
          'VERSION_MISMATCH',
          `version check failed: '${launcherName} ${args.join(' ')}' printed '${output}' but the requested release is ${options.version} (expected ${version}). The archive may not match the tag; try another --version${fromSourceClause(manifest, ', or use --from-source')}.`,
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
  const rust = await optionalRust(ctx);
  if (rust !== null) {
    entries.push(['rustc', rust.rustc], ['cargo', rust.cargo]);
  } else {
    entries.push(['build', `prebuilt archive ${tag}`]);
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

/**
 * Build-time environment from the manifest.  Upstream release CI bakes the
 * version into its binaries (Kuna: `KUNA_VERSION`), so a source build has to
 * set the same variables or the tool reports its Cargo workspace version.
 */
function resolveBuildEnv(
  spec: Record<string, string> | undefined,
  manifest: ToolManifest,
  taggedVersion: string | undefined,
): NodeJS.ProcessEnv | undefined {
  if (spec === undefined) {
    return undefined;
  }
  const version = manifest.release?.version ?? taggedVersion;
  const env: NodeJS.ProcessEnv = {};
  for (const [name, template] of Object.entries(spec)) {
    const value = template.replaceAll('{version}', version ?? '');
    if (value !== '') {
      env[name] = value;
    }
  }
  return Object.keys(env).length > 0 ? env : undefined;
}

async function stageSource(
  ctx: ResolvedContext,
  manifest: ToolManifest,
  options: InstallOptions,
  prefix: string,
  stage: string,
): Promise<StagedOutcome> {
  const source = manifest.source;
  if (source === undefined || source.build === undefined) {
    throw new InstallError('NO_SOURCE_BUILD', `${manifest.id} has no source build information`, {
      hint: 'install it from a release instead',
    });
  }
  const toolchain = await requireRust(ctx, manifest.id, manifest.requires?.rust);
  const sourceDir =
    options.source !== undefined && options.source !== ''
      ? path.resolve(options.source)
      : path.join(ctx.repoRoot, source.path);
  if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
    throw new InstallError(
      'SOURCE_MISSING',
      `${manifest.id} source directory not found: ${sourceDir}. The checkout lives at ${path.join(ctx.repoRoot, source.path)}; run 'git submodule update --init ${source.path}' or pass --source DIR.`,
    );
  }
  const buildManifest = path.join(sourceDir, source.build.manifest);
  if (!fs.existsSync(buildManifest)) {
    throw new InstallError('SOURCE_MISSING', `${sourceDir} exists but has no ${source.build.manifest}, so there is nothing Rust to build.`);
  }
  // A tagged checkout names the released version; manifests can turn it into a
  // build-time version variable the tool reports at runtime.
  const sourceTag = await gitOutput(ctx, ['-C', sourceDir, 'describe', '--tags', '--exact-match', 'HEAD']);
  const taggedVersion =
    sourceTag !== undefined && /^v?\d/.test(sourceTag) ? releaseVersionFromTag(sourceTag) : undefined;
  const buildEnv = resolveBuildEnv(source.build.env, manifest, taggedVersion);
  fs.mkdirSync(path.join(stage, 'bin'), { recursive: true });
  const args = [
    'build',
    '--release',
    ...source.build.packages.flatMap((name) => ['-p', name]),
    '--target-dir',
    path.join(stage, 'target'),
    '--manifest-path',
    buildManifest,
  ];
  const envHint =
    buildEnv === undefined ? '' : ` with ${Object.entries(buildEnv).map(([name, value]) => `${name}=${value}`).join(' ')}`;
  ctx.log(`building ${manifest.id} (cargo ${args.join(' ')})${envHint}`);
  const build = await runCommand(ctx, 'cargo', args, 'stream', buildEnv);
  if (build.error !== undefined || build.status !== 0) {
    throw new InstallError(
      'BUILD_FAILED',
      `cargo build failed. Check the build output above and the toolchain requirement in ${buildManifest}.`,
    );
  }
  const binDir = path.join(stage, 'target', 'release');
  const binaries: string[] = [];
  for (const name of manifest.bins ?? []) {
    const found = findFile(binDir, [name, `${name}.exe`]);
    if (found === null) {
      throw new InstallError(
        'BUILD_LAYOUT',
        `cargo build succeeded but neither ${name} nor ${name}.exe was produced at ${binDir}. The upstream [[bin]] name may have changed.`,
      );
    }
    copyExecutable(found, path.join(stage, 'bin', path.basename(found)));
    binaries.push(path.basename(found));
  }
  if (binaries.length === 0) {
    throw new InstallError('INSTALL_EMPTY', `${manifest.id} produced no binaries`);
  }
  const launcherName = pickLauncher(manifest, binaries);
  let specsInstalled = 0;
  if (source.specs !== undefined) {
    const specsDir = path.join(sourceDir, source.specs.path);
    if (!fs.existsSync(specsDir)) {
      throw new InstallError(
        'SPECS_MISSING',
        `SLEIGH specs not found: ${specsDir}. Run 'git submodule update --init --recursive ${source.path}'.`,
      );
    }
    copyTree(specsDir, path.join(stage, 'specs'));
    const compiler = findFile(path.join(stage, 'bin'), [source.specs.compiler, `${source.specs.compiler}.exe`]);
    if (compiler === null) {
      throw new InstallError(
        'BUILD_LAYOUT',
        `internal error: ${source.specs.compiler} is not among the built binaries, so the SLEIGH specs cannot be compiled.`,
      );
    }
    ctx.log(`compiling SLEIGH specs with ${path.basename(compiler)} -a (this can take a while)`);
    const compiled = await runCommand(ctx, compiler, ['-a', path.join(stage, 'specs')], 'stream');
    if (compiled.error !== undefined || compiled.status !== 0) {
      throw new InstallError(
        'SPECS_COMPILE_FAILED',
        `the SLEIGH compiler failed while compiling ${specsDir}; the vendored specs were rejected. Re-run 'make specs' in the checkout to see the full log.`,
      );
    }
    specsInstalled = countBySuffix(path.join(stage, 'specs'), '.sla');
    if (specsInstalled === 0) {
      throw new InstallError('SPECS_MISSING', 'the SLEIGH compiler produced no .sla files; refusing to install an uncompiled specs tree.');
    }
    ctx.log(`compiled ${specsInstalled} .sla files`);
  }
  const crateVersion = readPackageVersion(buildManifest);
  const repositoryRevision = (await gitOutput(ctx, ['-C', ctx.repoRoot, 'rev-parse', 'HEAD'])) ?? 'unknown';
  const repositoryBranch = (await gitOutput(ctx, ['-C', ctx.repoRoot, 'rev-parse', '--abbrev-ref', 'HEAD'])) ?? 'unknown';
  const upstreamRevision = (await gitOutput(ctx, ['-C', sourceDir, 'rev-parse', 'HEAD'])) ?? 'unknown (not a git checkout)';
  const gitlink = await gitlinkRevision(ctx, source.path);
  const versionFile = readFirstLine(path.join(sourceDir, 'VERSION'));
  const entries: Array<[string, string]> = [
    ['tool', manifest.id],
    ['installer', 'decx install'],
    ['install_method', 'source build'],
    ['installed', isoTimestamp()],
    ['source', sourceDir],
    ['crate_version', crateVersion],
    ['repository_revision', repositoryRevision],
    ['repository_branch', repositoryBranch],
    ['upstream_revision', upstreamRevision],
    ['superproject_gitlink', gitlink],
  ];
  if (versionFile !== undefined) {
    entries.push(['upstream_version_file', versionFile]);
  }
  if (sourceTag !== undefined && taggedVersion !== undefined) {
    entries.push(['upstream_tag', sourceTag]);
  }
  entries.push(['rustc', toolchain.rustc], ['cargo', toolchain.cargo]);
  entries.push(['specs_installed', String(specsInstalled)]);
  entries.push(
    ['binary', path.join(binRoot(ctx.home), launcherName)],
    ['binaries', binaries.join(' ')],
    ['bin_dir', binRoot(ctx.home)],
    ['prefix', prefix],
  );
  // The tag is the version upstream released; the Cargo version is the fallback
  // for untagged checkouts, the VERSION file for workspaces that carry none.
  const version = taggedVersion ?? (crateVersion !== 'unknown' ? crateVersion : versionFile);
  return {
    provenance: fromEntries(entries),
    binaries,
    launcherName,
    method: 'source build',
    ...(version !== undefined ? { version } : {}),
    specsInstalled,
  };
}

interface PythonSource extends Partial<Pick<StagedOutcome, 'version' | 'releaseTag' | 'releaseSource' | 'asset' | 'checksum'>> {
  directory: string;
  provenance: Record<string, string>;
}

/** GitHub source archives have one enclosing directory; mirrored payloads may be flat. */
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

function resetStage(stage: string): void {
  // No failed attempt's files may be combined with a different source.
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
}

function fallbackRecord(from: string, error: InstallError): Record<string, string> {
  return { fallback_from: from, fallback_reason: `${error.code}: ${error.message}` };
}

async function pythonSource(ctx: ResolvedContext, manifest: ToolManifest, stage: string): Promise<PythonSource> {
  const spec = manifest.python;
  if (spec === undefined) {
    throw new InstallError('NO_PYTHON_PAYLOAD', `${manifest.id} has no python block describing its payload`);
  }
  const archive = spec.archive;
  const local = spec.path === undefined ? undefined : path.join(ctx.repoRoot, spec.path);
  const localAvailable = local !== undefined && fs.existsSync(local) && fs.statSync(local).isDirectory();
  const upstream = localAvailable
    ? local
    : archive === undefined
      ? (local ?? '')
      : `${ctx.downloadBase.replace(/\/+$/, '')}/${archive.repository}/archive/${encodeURIComponent(archive.ref)}.tar.gz`;
  try {
    if (localAvailable) {
      return { directory: local, provenance: {} };
    }
    if (archive === undefined) {
      throw new InstallError('SOURCE_MISSING', `${manifest.id} source directory not found: ${upstream}`);
    }
    const dest = path.join(stage, 'downloads', 'source.tar.gz');
    const { sha256 } = await downloadRequired(ctx, upstream, dest);
    if (archive.sha256 !== undefined) {
      checkDigest('source.tar.gz', archive.sha256, sha256);
    }
    const extract = path.join(stage, 'extract');
    extractArchive(dest, extract);
    const checksum = archive.sha256 === undefined ? 'not pinned by the manifest' : `verified (${sha256})`;
    return {
      directory: pythonArchiveRoot(extract, spec.entry),
      checksum,
      provenance: {
        source: upstream,
        upstream_repository: `https://github.com/${archive.repository}`,
        upstream_revision: archive.ref,
        sha256,
        checksum,
      },
    };
  } catch (error) {
    const release = manifest.fallbackRelease;
    if (!sourceUnavailable(error) || release === undefined) {
      throw error;
    }
    ctx.log(`warning: ${upstream} unavailable; trying the fallback release (${error.code})`);
    resetStage(stage);
    const tag = await resolveInstallTag(ctx, manifest, release, {});
    const downloaded = await downloadRelease(ctx, manifest, release, stage, tag);
    const releaseSource = `https://github.com/${release.repository}`;
    return {
      directory: pythonArchiveRoot(downloaded.extract, spec.entry),
      version: downloaded.version,
      releaseTag: tag,
      releaseSource,
      asset: downloaded.asset,
      checksum: downloaded.checksum,
      provenance: {
        source: releaseDownloadUrl(ctx.downloadBase, release.repository, tag, downloaded.asset),
        upstream_repository: archive === undefined ? 'unknown' : `https://github.com/${archive.repository}`,
        upstream_revision: archive?.ref ?? 'unknown (release archive)',
        release_source: releaseSource,
        release_tag: tag,
        release_asset: downloaded.asset,
        version: downloaded.version,
        sha256: downloaded.sha256,
        checksum: downloaded.checksum,
        ...downloaded.extraProvenance,
        ...fallbackRecord(upstream, error),
      },
    };
  }
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
    throw new InstallError('SOURCE_MISSING', `${manifest.id} entry point not found: ${entry} -- not a ${manifest.id} checkout?`);
  }
  const requirements = path.join(sourceDir, spec.requirements);
  if (!fs.existsSync(requirements)) {
    throw new InstallError('SOURCE_MISSING', `${manifest.id} requirements not found: ${requirements} -- not a ${manifest.id} checkout?`);
  }
  const python = await findPython(ctx, manifest.id, manifest.requires?.python);
  const windows = ctx.platform !== null ? ctx.platform.startsWith('windows') : isWindows();
  const platformOs = ctx.platform !== null ? ctx.platform.split('-')[0] ?? 'unknown' : isWindows() ? 'windows' : process.platform;
  const venvBin = windows ? 'Scripts' : 'bin';
  const venvPythonName = windows ? 'python.exe' : 'python';
  const payload = path.join(stage, 'share', manifest.id);
  fs.mkdirSync(payload, { recursive: true });
  for (const item of spec.payload) {
    const from = path.join(sourceDir, item);
    if (!fs.existsSync(from)) {
      throw new InstallError('SOURCE_MISSING', `${manifest.id} payload ${from} not found -- not a ${manifest.id} checkout?`);
    }
    copyTree(from, path.join(payload, item));
  }
  fs.copyFileSync(entry, path.join(payload, spec.entry));
  for (const optional of [spec.requirements, 'LICENSE', 'README.md']) {
    const from = path.join(sourceDir, optional);
    if (fs.existsSync(from) && !fs.existsSync(path.join(payload, optional))) {
      fs.copyFileSync(from, path.join(payload, optional));
    }
  }
  const venvDir = path.join(payload, 'venv');
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
  const pipArgs = ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', path.join(payload, spec.requirements)];
  ctx.log('installing upstream requirements into the venv');
  const pip = await runCommand(ctx, venvPython, pipArgs, 'stream');
  if (pip.error !== undefined || pip.status !== 0) {
    throw new InstallError(
      'PIP_FAILED',
      `pip install failed. A network connection to PyPI is required; check the upstream pin in ${requirements}.`,
    );
  }
  fs.mkdirSync(path.join(stage, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(stage, 'bin', manifest.id), venvLauncherText({ id: manifest.id, platformOs, venvBin, venvPython: venvPythonName, entry: spec.entry }));
  applyExecutableMode(path.join(stage, 'bin', manifest.id));
  const binaries = [manifest.id];
  let launcherName = manifest.id;
  if (windows) {
    launcherName = `${manifest.id}.cmd`;
    fs.writeFileSync(path.join(stage, 'bin', launcherName), venvCmdLauncherText({ id: manifest.id, entry: spec.entry }));
  }
  if (ctx.verify && manifest.verify !== undefined && manifest.verify.args.length > 0) {
    const result = await runCommand(ctx, venvPython, [path.join(payload, spec.entry), ...manifest.verify.args]);
    if (result.error !== undefined || result.status !== 0) {
      throw new InstallError('VERIFY_FAILED', `${manifest.id} verification failed: ${firstLine(result) || result.error || 'no output'}`);
    }
  }
  const upstreamRevision = sourceProvenance.upstream_revision ?? (await gitOutput(ctx, ['-C', sourceDir, 'rev-parse', 'HEAD'])) ?? 'unknown (not a git checkout)';
  const gitlink = spec.path === undefined ? 'unknown' : await gitlinkRevision(ctx, spec.path);
  const entries: Array<[string, string]> = [
    ['tool', manifest.id],
    ['installer', 'decx install'],
    ['install_method', 'python venv'],
    ['installed', isoTimestamp()],
    ['source', sourceDir],
    ['upstream_revision', upstreamRevision],
    ['superproject_gitlink', gitlink],
    ['requirements', fs.readFileSync(requirements, 'utf8').trim()],
    ['platform', ctx.platform ?? platformOs],
    ['python', `${python.output} (${python.label})`],
    ['venv', path.join(prefix, 'venv', venvBin, venvPythonName)],
    ['binaries', binaries.join(' ')],
    ['bin_dir', binRoot(ctx.home)],
    [
      'launcher',
      `${path.join(binRoot(ctx.home), manifest.id)} -> ${path.join(prefix, spec.entry)}`,
    ],
  ];
  return { provenance: { ...fromEntries(entries), ...sourceProvenance }, binaries, launcherName, method: 'python venv', ...sourceMetadata };
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

/**
 * Moves a validated staging tree into the install: executables (or their
 * launchers) into `<home>/bin` (the store every tool shares) and everything else
 * into the payload `<home>/share/<id>`.  The payload is swapped as a whole, so a
 * failed move restores the previous one; a store file that belongs to another
 * tool is refused unless `force` is set.  With `wrap` the packaged binaries stay
 * in the payload (`<payload>/bin`) and the store holds launcher scripts that
 * export the manifest environment first.
 */
function commitStage(
  stage: string,
  home: string,
  id: string,
  force: boolean,
  log: (line: string) => void,
  wrap?: LauncherWrap,
): { bins: string[]; removed: string[]; launcher?: string } {
  const binDir = binRoot(home);
  const payload = toolPrefix(home, id);
  const previous = recordedBinaries(payload);
  const stagedBin = path.join(stage, 'bin');
  const names = listDirEntries(stagedBin)
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
  const storeNames = names.map((name) => (wrap === undefined ? name : launcherStoreName(name)));
  for (const name of storeNames) {
    const target = path.join(binDir, name);
    if (fs.existsSync(target) && !previous.includes(name) && !force) {
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
  const backup = `${payload}.decx-old-${process.pid}`;
  fs.rmSync(backup, { recursive: true, force: true });
  if (fs.existsSync(payload)) {
    fs.renameSync(payload, backup);
  }
  try {
    fs.mkdirSync(path.dirname(payload), { recursive: true });
    fs.renameSync(stagedShare, payload);
    const stagedSpecs = path.join(stage, 'specs');
    if (fs.existsSync(stagedSpecs)) {
      fs.renameSync(stagedSpecs, path.join(payload, 'specs'));
    }
  } catch (error) {
    fs.rmSync(payload, { recursive: true, force: true });
    if (fs.existsSync(backup)) {
      fs.renameSync(backup, payload);
    }
    throw error;
  }
  fs.rmSync(backup, { recursive: true, force: true });
  const packagedBin = path.join(payload, 'bin');
  if (wrap !== undefined) {
    fs.mkdirSync(packagedBin, { recursive: true });
  }
  const bins: string[] = [];
  let launcher: string | undefined;
  for (const [index, name] of names.entries()) {
    const storeName = storeNames[index] ?? name;
    const target = path.join(binDir, storeName);
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
    if (fs.existsSync(stale)) {
      fs.rmSync(stale, { force: true });
      removed.push(name);
      log(`removed stale executable ${stale}`);
    }
  }
  return { bins, removed, ...(launcher !== undefined ? { launcher } : {}) };
}

/**
 * Installs one tool into `<home>/share/<id>` and returns what landed where.
 * The prefix is never touched until staging and checks have succeeded.
 */
export async function installTool(
  manifest: ToolManifest,
  options: InstallOptions,
  context: InstallContext,
): Promise<InstallResult> {
  const home = assertInstallRoot(context.home);
  const ctx = resolveContext({ ...context, home });
  validateInstallOptions(manifest, options);
  const prefix = toolPrefix(home, manifest.id);
  fs.mkdirSync(prefix, { recursive: true });
  // The stage sits in DECX_HOME rather than in the payload (which is swapped as
  // a whole), and the executables it holds are moved into <home>/bin, so every
  // step is a rename on one filesystem.
  const stage = fs.mkdtempSync(path.join(home, '.decx-stage-'));
  const binDir = binRoot(home);
  try {
    let method = initialMethod(manifest, options);
    let outcome: StagedOutcome;
    if (method === 'python venv') {
      outcome = await stageVenv(ctx, manifest, prefix, stage, await pythonSource(ctx, manifest, stage));
    } else if (method === 'source build') {
      outcome = await stageSource(ctx, manifest, options, prefix, stage);
    } else {
      const release = manifest.release;
      if (release === undefined) {
        throw new InstallError('NO_RELEASE', `${manifest.id} has no release to download`, {
          ...fromSourceHint(manifest, 'use --from-source if a checkout is available'),
        });
      }
      const tag = await resolveInstallTag(ctx, manifest, release, options);
      if (tag === null) {
        ctx.log(`warning: no release of ${release.repository} could be resolved; falling back to the source build`);
        method = 'source build';
        outcome = await stageSource(ctx, manifest, options, prefix, stage);
      } else {
        outcome = await stageRelease(ctx, manifest, release, options, prefix, stage, tag);
      }
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
    const committed = commitStage(stage, home, manifest.id, options.force === true, ctx.log, wrap);
    const linkDir = resolveLinkDir(options.links, ctx.env);
    const links =
      options.noLinks === true
        ? []
        : createLinks({ home, files: committed.bins, linkDir, force: options.force === true, log: ctx.log });
    const storeLauncher = committed.launcher ?? outcome.launcherName;
    const provenance: Record<string, string> = {
      ...outcome.provenance,
      binary: path.join(binDir, storeLauncher),
      binaries: committed.bins.join(' '),
      bin_dir: binDir,
      ...(launcherVariables !== undefined ? { env: formatEnv(launcherVariables) } : {}),
      ...(options.noLinks === true ? {} : { link_dir: linkDir }),
      ...(links.length > 0 ? { links: links.map((link) => link.path).join(' ') } : {}),
    };
    fs.writeFileSync(path.join(prefix, 'PROVENANCE'), formatProvenance(provenance));
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
