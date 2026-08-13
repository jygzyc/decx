/**
 * decx-server.jar finder and installer.
 */

import * as path from "path";
import { existsSync, mkdirSync, renameSync, unlinkSync } from "fs";
import { downloadWithProgress } from "../utils/progress.js";
import { decxPath } from "./paths.js";

const DECX_SERVER_HOME: string | undefined = process.env.DECX_SERVER_HOME;
const DEFAULT_FETCH = fetch;

/**
 * Compare two semver strings (e.g. "2.2.1" vs "2.3.0").
 * Returns >0 if a > b, <0 if a < b, 0 if equal.
 */
function compareSemver(a: string, b: string): number {
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

const GITHUB_RELEASES_API = "https://api.github.com/repos/jygzyc/decx/releases";

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
}

function releasesEndpoint(prerelease: boolean): string {
  return prerelease
    ? `${GITHUB_RELEASES_API}?per_page=10`
    : `${GITHUB_RELEASES_API}/latest`;
}

type ReleaseFetchResult =
  | { ok: true; release: ReleaseSummary }
  | { ok: false; message: string };

/** Fetch the latest stable release, or the newest prerelease. */
async function fetchReleaseSummary(
  prerelease: boolean,
  fetchImpl: typeof fetch = DEFAULT_FETCH,
  timeoutMs?: number,
): Promise<ReleaseFetchResult> {
  const res = await fetchImpl(releasesEndpoint(prerelease), {
    headers: { "Accept": "application/vnd.github+json" },
    ...(timeoutMs !== undefined ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
  });
  if (!res.ok) {
    return { ok: false, message: `GitHub API error: HTTP ${res.status}` };
  }
  if (prerelease) {
    const releases = await res.json() as Array<ReleaseSummary & { prerelease: boolean }>;
    const pre = releases.find((r) => r.prerelease);
    if (!pre) return { ok: false, message: "No prerelease found" };
    return { ok: true, release: pre };
  }
  return { ok: true, release: await res.json() as ReleaseSummary };
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

  if (hadExisting) {
    renameSync(installPath, backupPath);
  }

  try {
    renameSync(tmpPath, installPath);
    if (hadExisting && existsSync(backupPath)) {
      unlinkSync(backupPath);
    }
  } catch (error) {
    if (existsSync(tmpPath)) {
      unlinkSync(tmpPath);
    }
    if (hadExisting && existsSync(backupPath)) {
      renameSync(backupPath, installPath);
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
  fetchImpl: typeof fetch = DEFAULT_FETCH,
): Promise<{ available: boolean; latestVersion: string; error?: string }> {
  let fetched: ReleaseFetchResult;
  try {
    fetched = await fetchReleaseSummary(prerelease, fetchImpl, 15_000);
  } catch (err) {
    return {
      available: false,
      latestVersion: currentVersion,
      error: `GitHub API request failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!fetched.ok) {
    return { available: false, latestVersion: currentVersion, error: fetched.message };
  }

  const latest = normalizeVersion(fetched.release.tag_name);
  const available = compareSemver(latest, currentVersion.replace(/^v/, "")) > 0;
  return { available, latestVersion: latest };
}

/**
 * Download and install the latest decx-server.jar from GitHub releases.
 * Returns [success, message, version?].
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
  } = options;

  try {
    logger.error(`  Fetching latest ${prerelease ? "prerelease" : "release"} info from GitHub...`);

    const fetched = await fetchReleaseSummary(prerelease, fetchImpl);
    if (!fetched.ok) {
      return { ok: false, message: fetched.message };
    }
    const release = fetched.release;

    const asset = selectDecxServerAsset(release.assets);

    if (!asset) {
      return { ok: false, message: `No decx-server jar asset found in release ${release.tag_name}` };
    }

    mkdirSync(installDir, { recursive: true });

    const downloadRes = await fetchImpl(asset.browser_download_url, { redirect: "follow" });
    if (!downloadRes.ok || !downloadRes.body) {
      return { ok: false, message: `Download failed: HTTP ${downloadRes.status}` };
    }

    const tmpPath = `${installPath}.tmp`;
    const totalSize = Number(downloadRes.headers.get("content-length") || 0);
    await downloadWithProgressImpl(downloadRes.body, tmpPath, totalSize, {
      label: asset.name,
    });

    try {
      replaceInstalledJar(tmpPath, installPath);
    } catch {
      return { ok: false, message: "Failed to save downloaded file" };
    }

    const version = normalizeVersion(release.tag_name);
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
