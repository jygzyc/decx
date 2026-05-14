/**
 * decx-server.jar finder and installer.
 */

import * as path from "path";
import { existsSync, mkdirSync, renameSync, unlinkSync } from "fs";
import { downloadWithProgress } from "../utils/progress.js";
import { decxPath } from "../core/paths.js";

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
 */
export async function checkForServerUpdate(
  currentVersion: string,
  prerelease: boolean = false
): Promise<{ available: boolean; latestVersion: string }> {
  const endpoint = prerelease
    ? "https://api.github.com/repos/jygzyc/decx/releases?per_page=10"
    : "https://api.github.com/repos/jygzyc/decx/releases/latest";

  const res = await fetch(endpoint, {
    headers: { "Accept": "application/vnd.github+json" },
  });
  if (!res.ok) return { available: false, latestVersion: currentVersion };

  let latestTag: string;
  if (prerelease) {
    const releases = await res.json() as Array<{ tag_name: string; prerelease: boolean }>;
    const pre = releases.find((r) => r.prerelease);
    if (!pre) return { available: false, latestVersion: currentVersion };
    latestTag = pre.tag_name;
  } else {
    const release = await res.json() as { tag_name: string };
    latestTag = release.tag_name;
  }

  const latest = latestTag.replace(/^v/, "");
  const current = currentVersion.replace(/^v/, "");
  const available = compareSemver(latest, current) > 0;
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

    const endpoint = prerelease
      ? "https://api.github.com/repos/jygzyc/decx/releases?per_page=10"
      : "https://api.github.com/repos/jygzyc/decx/releases/latest";

    const res = await fetchImpl(endpoint, {
      headers: { "Accept": "application/vnd.github+json" },
    });
    if (!res.ok) {
      return { ok: false, message: `GitHub API error: HTTP ${res.status}` };
    }

    let release: ReleaseSummary;

    if (prerelease) {
      const releases = await res.json() as Array<ReleaseSummary & { prerelease: boolean }>;
      const pre = releases.find((r) => r.prerelease);
      if (!pre) {
        return { ok: false, message: "No prerelease found" };
      }
      release = pre;
    } else {
      release = await res.json() as ReleaseSummary;
    }

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
