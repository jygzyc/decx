/**
 * decx-server.jar finder and installer.
 *
 * Release discovery deliberately avoids the GitHub REST API, which is
 * rate-limited to 60 requests/hour per IP for unauthenticated clients:
 * - the latest stable version comes from the npm registry (`@jygzyc/decx-cli`
 *   is published from the same tag as the server jar)
 * - prerelease versions come from the GitHub releases atom feed
 * - jar assets are downloaded from deterministic /releases/download URLs
 * None of these require the GitHub API, a token, or an installed `gh` CLI.
 */

import * as path from "path";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync } from "fs";
import { inflateRawSync } from "node:zlib";
import { downloadWithProgress } from "../utils/progress.js";
import { decxPath } from "./paths.js";

const DECX_SERVER_HOME: string | undefined = process.env.DECX_SERVER_HOME;
const DEFAULT_FETCH = fetch;

const NPM_PACKAGE = "@jygzyc/decx-cli";
const NPM_LATEST_URL = `https://registry.npmjs.org/${NPM_PACKAGE}/latest`;
const GITHUB_REPO = "jygzyc/decx";
const RELEASES_ATOM_URL = `https://github.com/${GITHUB_REPO}/releases.atom`;

/**
 * Compare two semver strings (e.g. "2.2.1" vs "2.3.0").
 * Returns >0 if a > b, <0 if a < b, 0 if equal.
 */
export function compareSemver(a: string, b: string): number {
  const pa = a.split("-")[0].split(".").map(Number);
  const pb = b.split("-")[0].split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va !== vb) return va - vb;
  }
  return 0;
}

const INSTALL_DIR = decxPath("bin");
const INSTALL_PATH = path.join(INSTALL_DIR, "decx-server.jar");

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

interface ReleaseSummary {
  tag_name: string;
  assets: ReleaseAsset[];
}

export type InstallDecxServerResult =
  | { ok: true; message: string; version: string; path: string }
  | { ok: false; message: string };

interface InstallDecxServerOptions {
  fetchImpl?: typeof fetch;
  downloadWithProgressImpl?: typeof downloadWithProgress;
  installDir?: string;
  installPath?: string;
  logger?: Pick<Console, "error">;
  /** Installed server version; when it matches the latest release, skip the download. */
  currentVersion?: string;
}

type ReleaseFetchResult =
  | { ok: true; release: ReleaseSummary }
  | { ok: false; message: string };

function assetUrl(version: string): string {
  return `https://github.com/${GITHUB_REPO}/releases/download/v${version}/decx-server-${version}.jar`;
}

/** Build a release summary from a version using deterministic asset naming. */
function summaryForVersion(version: string): ReleaseSummary {
  return {
    tag_name: `v${version}`,
    assets: [{ name: `decx-server-${version}.jar`, browser_download_url: assetUrl(version) }],
  };
}

/** Matches version tags with a prerelease suffix, e.g. v4.2.0-rc.1. */
const PRERELEASE_VERSION_RE = /^v?\d+\.\d+\.\d+-/;

/**
 * Discover the latest stable release (npm registry) or newest prerelease
 * (GitHub releases atom feed). Both sources are unauthenticated and not
 * subject to GitHub API rate limits.
 */
async function fetchReleaseSummary(
  prerelease: boolean,
  fetchImpl: typeof fetch = DEFAULT_FETCH,
  timeoutMs: number = 15_000,
): Promise<ReleaseFetchResult> {
  const signal = AbortSignal.timeout(timeoutMs);

  if (prerelease) {
    try {
      const res = await fetchImpl(RELEASES_ATOM_URL, {
        headers: { Accept: "application/atom+xml" },
        signal,
      });
      if (res.ok) {
        const text = await res.text();
        const titles = [...text.matchAll(/<title>([^<]+)<\/title>/g)].map((m) => m[1].trim());
        const pre = titles.find((title) => PRERELEASE_VERSION_RE.test(title));
        if (pre) {
          return { ok: true, release: summaryForVersion(pre.replace(/^v/, "")) };
        }
      }
      return { ok: false, message: "No prerelease found" };
    } catch (err) {
      return {
        ok: false,
        message: `Failed to reach GitHub releases feed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  try {
    const res = await fetchImpl(NPM_LATEST_URL, {
      headers: { Accept: "application/json" },
      signal,
    });
    if (res.ok) {
      const data = await res.json() as { version?: string };
      if (typeof data.version === "string" && data.version.length > 0) {
        return { ok: true, release: summaryForVersion(data.version) };
      }
    }
    return {
      ok: false,
      message: `Failed to fetch latest version from the npm registry (HTTP ${res.status})`,
    };
  } catch (err) {
    return {
      ok: false,
      message: `Failed to reach npm registry: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Latest stable version string from the npm registry, or null when the
 * lookup fails (network error, non-OK response, malformed payload).
 */
export async function fetchLatestStableVersion(
  fetchImpl: typeof fetch = DEFAULT_FETCH,
  timeoutMs: number = 15_000,
): Promise<string | null> {
  const fetched = await fetchReleaseSummary(false, fetchImpl, timeoutMs);
  return fetched.ok ? normalizeVersion(fetched.release.tag_name) : null;
}

/**
 * Find decx-server.jar from known locations.
 * Priority: DECX_SERVER_HOME env > ~/.decx/bin/decx-server.jar
 */
export function findDecxServerJar(): string | null {
  if (DECX_SERVER_HOME) {
    if (DECX_SERVER_HOME.endsWith(".jar") && existsSync(DECX_SERVER_HOME)) return DECX_SERVER_HOME;
    const fromDir = path.join(DECX_SERVER_HOME, "decx-server.jar");
    if (existsSync(fromDir)) return fromDir;
  }

  if (existsSync(INSTALL_PATH)) return INSTALL_PATH;

  return null;
}

export function selectDecxServerAsset(assets: ReleaseAsset[]): ReleaseAsset | undefined {
  return assets.find((asset) => asset.name.includes("decx-server") && asset.name.endsWith(".jar"));
}

function normalizeVersion(tag: string): string {
  return tag.replace(/^v/, "");
}

function replaceInstalledJar(tmpPath: string, installPath: string): void {
  const backupPath = `${installPath}.bak`;
  const hadExisting = existsSync(installPath);

  try {
    if (hadExisting) {
      renameSync(installPath, backupPath);
    }
    renameSync(tmpPath, installPath);
    if (hadExisting && existsSync(backupPath)) {
      unlinkSync(backupPath);
    }
  } catch (error) {
    // Best-effort cleanup: drop the partial download and restore the old jar.
    if (existsSync(tmpPath)) {
      try {
        unlinkSync(tmpPath);
      } catch { /* ignore */ }
    }
    if (hadExisting && !existsSync(installPath) && existsSync(backupPath)) {
      try {
        renameSync(backupPath, installPath);
      } catch { /* ignore */ }
    }
    throw error;
  }
}

/**
 * Check if a newer server version is available.
 * `error` is set when the check itself failed (network/API error) — callers
 * must not treat that as "no update available".
 */
export async function checkForServerUpdate(
  currentVersion: string,
  prerelease: boolean = false,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<{ available: boolean; latestVersion: string; error?: string }> {
  const fetched = await fetchReleaseSummary(prerelease, options.fetchImpl ?? DEFAULT_FETCH);
  if (!fetched.ok) {
    return { available: false, latestVersion: currentVersion, error: fetched.message };
  }

  const latest = normalizeVersion(fetched.release.tag_name);
  const available = compareSemver(latest, currentVersion.replace(/^v/, "")) > 0;
  return { available, latestVersion: latest };
}

/**
 * Read `version=<x.y.z>` from the `version.properties` entry inside a jar
 * (the same resource `DecxConstants` reads at server startup).
 *
 * Parses the zip central directory directly — no external zip dependency —
 * and supports both stored and deflated entries. Returns null when the file
 * is missing, malformed, or has no readable version.
 */
export function readJarVersionProperty(jarPath: string): string | null {
  let buf: Buffer;
  try {
    buf = readFileSync(jarPath);
  } catch {
    return null;
  }
  try {
    const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])); // "PK\x05\x06"
    if (eocd < 0) return null;
    const entryCount = buf.readUInt16LE(eocd + 10);
    let p = buf.readUInt32LE(eocd + 16); // central directory offset
    for (let i = 0; i < entryCount; i++) {
      if (buf.readUInt32LE(p) !== 0x02014b50) return null; // "PK\x01\x02"
      const method = buf.readUInt16LE(p + 10);
      const compressedSize = buf.readUInt32LE(p + 20);
      const nameLen = buf.readUInt16LE(p + 28);
      const extraLen = buf.readUInt16LE(p + 30);
      const commentLen = buf.readUInt16LE(p + 32);
      const localHeaderOffset = buf.readUInt32LE(p + 42);
      const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
      if (name === "version.properties") {
        // Local header repeats name/extra lengths; data follows them.
        const lNameLen = buf.readUInt16LE(localHeaderOffset + 26);
        const lExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
        const dataStart = localHeaderOffset + 30 + lNameLen + lExtraLen;
        const data = buf.subarray(dataStart, dataStart + compressedSize);
        const content = method === 8 ? inflateRawSync(data).toString("utf8") : data.toString("utf8");
        const match = content.match(/^version=([\w.-]+)\s*$/m);
        return match ? match[1] : null;
      }
      p += 46 + nameLen + extraLen + commentLen;
    }
  } catch {
    return null;
  }
  return null;
}

/** Version recorded inside the installed decx-server.jar, or null when absent/unreadable. */
export function installedServerVersion(installPath: string = INSTALL_PATH): string | null {
  return existsSync(installPath) ? readJarVersionProperty(installPath) : null;
}

/**
 * Download and install the latest decx-server.jar from GitHub releases.
 */
export async function installDecxServer(
  prerelease: boolean = false,
  options: InstallDecxServerOptions = {}
): Promise<InstallDecxServerResult> {
  const {
    fetchImpl = DEFAULT_FETCH,
    downloadWithProgressImpl = downloadWithProgress,
    installDir = INSTALL_DIR,
    installPath = INSTALL_PATH,
    logger = console,
    currentVersion,
  } = options;

  try {
    logger.error(`  Fetching latest ${prerelease ? "prerelease" : "release"} info...`);

    const fetched = await fetchReleaseSummary(prerelease, fetchImpl);
    if (!fetched.ok) {
      return { ok: false, message: fetched.message };
    }
    const release = fetched.release;

    const version = normalizeVersion(release.tag_name);

    // Prefer the version recorded inside the installed jar itself (ground
    // truth) over the config record, which may be missing or stale after a
    // manual jar replacement. Local and remote versions match: nothing to
    // download.
    const jarVersion = existsSync(installPath) ? readJarVersionProperty(installPath) : null;
    const effectiveVersion = jarVersion ?? currentVersion;
    if (effectiveVersion !== undefined && effectiveVersion === version && existsSync(installPath)) {
      return {
        ok: true,
        message: `decx-server is already up to date (v${version})`,
        version,
        path: installPath,
      };
    }

    const asset = selectDecxServerAsset(release.assets);

    if (!asset) {
      return { ok: false, message: `No decx-server jar asset found in release ${release.tag_name}` };
    }

    mkdirSync(installDir, { recursive: true });

    const downloadRes = await fetchImpl(asset.browser_download_url, { redirect: "follow" });
    if (!downloadRes.ok || !downloadRes.body) {
      return {
        ok: false,
        message: `Download failed: HTTP ${downloadRes.status} (the release may still be publishing; retry shortly)`,
      };
    }

    const tmpPath = `${installPath}.tmp`;
    const totalSize = Number(downloadRes.headers.get("content-length") || 0);
    await downloadWithProgressImpl(downloadRes.body, tmpPath, totalSize, {
      label: asset.name,
    });

    try {
      replaceInstalledJar(tmpPath, installPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "EPERM" || code === "EACCES" || code === "EBUSY") {
        return {
          ok: false,
          message:
            `Cannot replace ${installPath}: the file is in use by a running session. ` +
            `Close sessions with 'decx process close --all' and retry.`,
        };
      }
      return { ok: false, message: `Failed to save downloaded file: ${err instanceof Error ? err.message : String(err)}` };
    }

    return {
      ok: true,
      message: `Installed decx-server ${release.tag_name} to ${installPath}`,
      version,
      path: installPath,
    };
  } catch (err) {
    return { ok: false, message: `Installation failed: ${err}` };
  }
}
