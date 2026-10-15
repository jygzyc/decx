/**
 * Install upstream release archives or PyPI packages into an isolated stage,
 * then atomically commit executables, payload, launch metadata and PROVENANCE.
 * Python virtualenvs are initialized at their permanent path under rollback.
 * Runtimes are probed, never installed.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runCommand } from '../bridge/process.ts';
import { launcherText, shellQuote, type LaunchEntry } from '../bridge/launch.ts';
import { javascriptEntry, requireNode, stageJavascriptRelease } from '../bridge/javascript.ts';
import { stageVenv } from '../bridge/python.ts';
import { InstallError } from '../core/errors.ts';
import type { InstallContext, InstallOptions, InstallResult, ResolvedInstallContext as ResolvedContext, StagedOutcome } from './types.ts';
import { extractArchive } from './archive.ts';
import { applyExecutableMode, indexFiles, listDirEntries, lstatIfPresent, walkFiles } from '../core/fs.ts';
import { binRoot, resolveLinkDir, runtimePath, toolPrefix } from '../core/config.ts';
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
  versionFromTag,
  type ResolvedRelease,
} from '../download/github.ts';
import { isSafeRelativePath, verifyArgs, type ReleaseSpec, type ToolManifest } from '../catalog/manifest.ts';
import { isoTimestamp, provenanceBinaries, readProvenance } from './state.ts';
import { currentPlatformKey, isWindows, type PlatformKey } from '../core/platform.ts';

function resolveContext(context: InstallContext): ResolvedContext {
  const apiBase = context.apiBase ?? DEFAULT_API_BASE;
  return {
    home: context.home,
    env: context.env ?? process.env,
    platform: context.platform !== undefined ? context.platform : currentPlatformKey(),
    apiBase,
    github: { apiBase, userAgent: DEFAULT_USER_AGENT },
    downloadBase: context.downloadBase ?? DEFAULT_DOWNLOAD_BASE,
    log: (line: string) => process.stderr.write(`${line}\n`),
  };
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

/** Explicit full tags stay untouched; bare versions use only an explicit prefix. */
export function normalizeReleaseTag(tag: string, tagPrefix?: string): string {
  const value = tag.trim();
  if (value === '') {
    throw new InstallError('USAGE', 'release tag must not be empty', { exitCode: 2 });
  }
  if (tagPrefix !== undefined && tagPrefix !== '') {
    if (value.startsWith(tagPrefix)) {
      return value;
    }
    return /^\d/.test(value) ? `${tagPrefix}${value}` : value;
  }
  return value;
}

export { versionFromTag as releaseVersionFromTag } from '../download/github.ts';

/** The asset for one platform with `{version}`/`{os}`/`{arch}` substituted, or null. */
export function releaseAssetName(release: ReleaseSpec, platform: PlatformKey | null, version: string): string | null {
  if (release.asset !== undefined) {
    if (platform === null) {
      return null;
    }
    return expandAssetTemplate(release.asset, platform, version);
  }
  const template = (platform === null ? undefined : release.assets?.[platform]) ?? release.assets?.any;
  return template === undefined ? null : expandAssetTemplate(template, platform, version);
}

function expandAssetTemplate(template: string, platform: PlatformKey | null, version: string): string {
  const [os, arch] = platform?.split('-') ?? [];
  return template.replaceAll('{version}', version).replaceAll('{os}', os ?? '').replaceAll('{arch}', arch ?? '');
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
  const resolved = Object.fromEntries(Object.entries(manifest.env).map(([name, value]) => {
    const expanded = value.replaceAll('{prefix}', prefix).replaceAll('{version}', version);
    return [name, value.includes('{prefix}') ? path.normalize(expanded) : expanded];
  }));
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

function copyExecutable(source: string, dest: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(source, dest);
  applyExecutableMode(dest);
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

type SelectedRelease = Pick<ResolvedRelease, 'tag' | 'digests'>;

async function resolveInstallRelease(ctx: ResolvedContext, release: ReleaseSpec, options: InstallOptions): Promise<SelectedRelease> {
  const requested = options.version ?? release.version;
  const explicit = requested !== undefined && requested !== 'latest' && requested.trim() !== '' ? requested.trim() : undefined;
  if (explicit !== undefined && (release.tagPrefix !== undefined || !/^\d/.test(explicit))) {
    return { tag: normalizeReleaseTag(explicit, release.tagPrefix) };
  }
  const asset = releaseAssetName(release, ctx.platform, '{version}');
  if (asset === null) {
    throw new InstallError('UNSUPPORTED_PLATFORM', `no archive is defined for this platform (${ctx.platform ?? `${process.platform}-${process.arch}`})`);
  }
  try {
    const resolved = await resolveRelease({
      ...ctx.github,
      repository: release.repository,
      ...(release.tagPrefix !== undefined ? { tagPrefix: release.tagPrefix } : {}),
      ...(explicit !== undefined ? { version: explicit } : {}),
      asset,
      extraAssets: Object.values(release.extraAssets ?? {}).map(template => expandAssetTemplate(template, ctx.platform, '{version}')),
    });
    return resolved;
  } catch (error) {
    throw new InstallError('RELEASE_RESOLVE_FAILED', `could not resolve a release of ${release.repository}: ${(error as Error).message}`, {
      hint: 'pass --version <tag> to pick a release explicitly',
    });
  }
}

async function downloadRequired(ctx: ResolvedContext, url: string, dest: string) {
  ctx.log(`downloading ${url}`);
  try {
    return await downloadAsset(url, dest, ctx.github);
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
  const authentication = ctx.github;
  try {
    if (release.checksums === null) {
      return await releaseAssetDigests({ ...authentication, repository: release.repository, tag });
    }
    const name = release.checksums.replaceAll('{version}', versionFromTag(tag, release.tagPrefix));
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
  selected: SelectedRelease,
): Promise<ReleaseArchive> {
  const tag = selected.tag;
  const version = versionFromTag(tag, release.tagPrefix);
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
  const checksums = release.checksums === null && selected.digests !== undefined
    ? selected.digests : await releaseChecksums(ctx, release, tag, downloads);
  const assetUrl = releaseDownloadUrl(ctx.downloadBase, release.repository, tag, asset);
  const { sha256 } = await downloadRequired(ctx, assetUrl, path.join(downloads, asset));
  const checksum = verifyChecksum(ctx, asset, sha256, checksums);
  extractArchive(path.join(downloads, asset), extract);
  let specsAsset: string | undefined;
  const extraProvenance: Record<string, string> = {};
  for (const [key, template] of Object.entries(release.extraAssets ?? {})) {
    const extraName = expandAssetTemplate(template, ctx.platform, version);
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

async function stageRelease(
  ctx: ResolvedContext,
  manifest: ToolManifest,
  release: ReleaseSpec,
  options: InstallOptions,
  prefix: string,
  stage: string,
  selected: SelectedRelease,
): Promise<StagedOutcome> {
  const tag = selected.tag;
  const { extract, version, asset, sha256, checksum, specsAsset, extraProvenance } = await downloadRelease(ctx, release, stage, selected);
  const share = path.join(stage, 'share', manifest.id);
  fs.mkdirSync(share, { recursive: true });
  let verifyScript: string | undefined;
  const binaries: string[] = [];
  if (manifest.launch.type === 'js') {
    const staged = stageJavascriptRelease(manifest, extract, stage, asset, isWindows(), prefix);
    binaries.push(...staged.binaries);
    verifyScript = staged.verifyScript;
  } else {
    const files = indexFiles(extract);
    for (const name of manifest.launch.commands) {
      const found = files.get(name) ?? files.get(`${name}.exe`);
      if (found === undefined) {
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
    const probe = verifyScript === undefined ? { command: launcherPath, args } : javascriptEntry(verifyScript, args);
    const result = await runCommand(probe.command, probe.args, { env: { ...ctx.env, ...launcherEnv(manifest, share, version) } });
    const output = `${result.stdout}\n${result.stderr}`.trim();
    if (result.failed) {
      throw new InstallError(
        'VERIFY_FAILED',
        `could not run '${launcherName} ${args.join(' ')}' (captured output: ${output || result.shortMessage || 'none'}). The downloaded binary cannot execute on this host.`,
      );
    }
    // A tag can carry an upstream version that is not the tag itself; when the
    // user pinned one, the tool has to report it back.
    if (options.version !== undefined && args.includes('--version')) {
      const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(`(^|[^0-9.])${escaped}([^0-9.]|$)`);
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
  const provenance: Record<string, string> = {
    release_source: `https://github.com/${release.repository}`,
    release_tag: tag,
    version,
    platform: ctx.platform ?? `${process.platform}-${process.arch}`,
    release_asset: asset,
    checksum,
    sha256,
    specs_installed: String(specsInstalled),
    prefix,
    ...extraProvenance,
  };
  if (specsAsset !== undefined) provenance.specs_asset = specsAsset;
  if (reported !== '') provenance.reported_version = reported;
  const entry: LaunchEntry = verifyScript === undefined
    ? { command: path.join(binRoot(ctx.home), launcherName), args: [] }
    : javascriptEntry(path.join(prefix, 'app', path.relative(path.join(share, 'app'), verifyScript)));
  return {
    entry,
    provenance,
    binaries,
    launcherName,
  };
}

/** Finish layout in staging; the transaction only moves ready-to-install files. */
function stageEnvironment(stage: string, prefix: string, id: string, outcome: StagedOutcome, env: Record<string, string>): void {
  const packagedBin = path.join(stage, 'share', id, 'bin');
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
  initialize: StagedOutcome['initialize'],
  finalize: (committed: CommittedStage, initialized: Record<string, string> | undefined) => void,
  replaceRuntime = false,
): Promise<CommittedStage> {
  const binDir = binRoot(home);
  const payload = toolPrefix(home, id);
  const record = readProvenance(path.join(payload, 'PROVENANCE'));
  if (lstatIfPresent(payload) !== undefined && record?.tool !== id) {
    throw new InstallError('PAYLOAD_CONFLICT', `${payload} exists without a valid ${id} PROVENANCE; refusing to replace unrelated files`);
  }
  const previous = provenanceBinaries(record ?? {})
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
  const backups = new Map<string, string>();
  const undo: Array<() => void> = [];
  // Payload, runtime and executables use the same reversible replacement.
  function replace(source: string | undefined, target: string, backup: string): void {
    if (lstatIfPresent(target) !== undefined) {
      fs.mkdirSync(path.dirname(backup), { recursive: true });
      fs.renameSync(target, backup);
      backups.set(target, backup);
      undo.push(() => fs.renameSync(backup, target));
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    undo.push(() => fs.rmSync(target, { recursive: true, force: true }));
    if (source !== undefined) fs.renameSync(source, target);
  }
  let committed: CommittedStage;
  try {
    replace(stagedShare, payload, path.join(backupRoot, 'payload'));
    if (replaceRuntime) replace(undefined, runtimePath(home, id), path.join(backupRoot, 'runtime'));
    const initialized = await initialize?.();
    for (const name of new Set([...names, ...previous])) {
      replace(names.includes(name) ? path.join(stagedBin, name) : undefined,
        path.join(binDir, name), path.join(backupRoot, 'bin', name));
    }
    const removed = previous.filter(name => !names.includes(name) && backups.has(path.join(binDir, name)));
    for (const name of removed) log(`removed stale executable ${path.join(binDir, name)}`);
    committed = { bins: names, removed };
    finalize(committed, initialized);
  } catch (error) {
    // Reverse every completed operation; retain backups if rollback itself fails.
    for (const restore of undo.reverse()) restore();
    fs.rmSync(backupRoot, { recursive: true, force: true });
    throw error;
  }
  const foreignBins = names.filter(name => !previous.includes(name) && backups.has(path.join(binDir, name)));
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
  if (manifest.launch.type === 'js') await requireNode(ctx);
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
      const token = githubToken(ctx.env);
      if (token !== undefined) ctx.github.token = token;
      outcome = await stageRelease(ctx, manifest, release, options, prefix, stage, await resolveInstallRelease(ctx, release, options));
    }
    const stageShare = path.join(stage, 'share', manifest.id);
    fs.mkdirSync(stageShare, { recursive: true });
    const launcherVariables = launcherEnv(manifest, prefix, outcome.provenance.version ?? '');
    if (launcherVariables !== undefined) stageEnvironment(stage, prefix, manifest.id, outcome, launcherVariables);
    const linkDir = resolveLinkDir(options.links, ctx.env);
    let links: LinkOutcome[] = [];
    const storeLauncher = outcome.launcherName;
    let provenance: Record<string, string> = {};
    const committed = await commitStage(stage, home, manifest.id, options.force === true, ctx.log, outcome.initialize, (committed, initialized) => {
      provenance = {
        ...outcome.provenance,
        ...initialized,
        tool: manifest.id,
        installer: 'decx install',
        install_method: method,
        installed: isoTimestamp(),
        binary: path.join(binDir, storeLauncher),
        binaries: committed.bins.join(' '),
        bin_dir: binDir,
      };
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
      method,
      prefix,
      binDir,
      launcher: path.join(binDir, storeLauncher),
      binaries: committed.bins,
      ...(provenance.version !== undefined ? { version: provenance.version } : {}),
      ...(provenance.release_tag !== undefined ? { releaseTag: provenance.release_tag } : {}),
      ...(provenance.release_source !== undefined ? { releaseSource: provenance.release_source } : {}),
      ...(provenance.release_asset !== undefined ? { asset: provenance.release_asset } : {}),
      ...(provenance.specs_asset !== undefined ? { specsAsset: provenance.specs_asset } : {}),
      ...(provenance.specs_installed !== undefined ? { specsInstalled: Number(provenance.specs_installed) } : {}),
      ...(provenance.checksum !== undefined ? { checksum: provenance.checksum } : {}),
      provenance,
      pathHint: pathHint(pathDir, isWindows()),
    };
    if (options.noLinks !== true) { result.links = links; result.linkDir = linkDir; }
    ctx.log(`installed ${manifest.id} (${method})`);
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
