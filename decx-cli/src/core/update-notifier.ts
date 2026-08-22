/**
 * Startup update notifier.
 *
 * Non-blocking, cache-based update check inspired by npm/pnpm:
 * - startup only reads the cache file synchronously; a newer cached version
 *   prints a one-line hint to stderr (stdout JSON stays pipe-safe)
 * - when the cache is stale (older than UPDATE_CHECK_INTERVAL_MS), a detached
 *   child process re-runs the CLI as `__update-check` to refresh it in the
 *   background; the main process never waits on the network
 * - the check never breaks normal commands: every failure is swallowed
 *
 * The npm registry is the version source (same tag as the server jar), so the
 * hint points at `decx self update`, which upgrades both.
 *
 * Opt out with DECX_NO_UPDATE_CHECK=1 (also skipped in CI and in the
 * background child itself via DECX_UPDATE_CHECK_CHILD).
 */

import { spawn } from "child_process";
import { existsSync, readFileSync } from "fs";
import { fileURLToPath } from "url";
import { decxPath } from "./paths.js";
import { atomicWriteJson } from "../utils/fs.js";
import { compareSemver, fetchLatestStableVersion } from "./installer.js";
import { VERSION } from "./version.js";

export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

const STABLE_VERSION_RE = /^\d+\.\d+\.\d+$/;

export interface UpdateCheckCache {
  lastCheck: number;
  latestVersion: string;
}

export interface UpdateNotifierDeps {
  env?: NodeJS.ProcessEnv;
  now?: number;
  version?: string;
  cacheFile?: string;
  entryFile?: string;
  spawnImpl?: typeof spawn;
  logger?: Pick<Console, "error">;
}

export function readUpdateCheckCache(cacheFile: string): UpdateCheckCache | null {
  try {
    if (!existsSync(cacheFile)) return null;
    const data = JSON.parse(readFileSync(cacheFile, "utf-8")) as Partial<UpdateCheckCache>;
    if (typeof data.lastCheck !== "number" || typeof data.latestVersion !== "string") return null;
    return { lastCheck: data.lastCheck, latestVersion: data.latestVersion };
  } catch {
    return null;
  }
}

export function formatUpdateNotice(latestVersion: string, currentVersion: string): string {
  return `  Update available: decx v${latestVersion} (current v${currentVersion}). Run 'decx self update' to upgrade.`;
}

/**
 * Startup entry point: print a hint when the cache knows of a newer version,
 * then kick off a detached cache refresh when the cache is stale. Synchronous
 * and side-effect-safe; intended to run before command parsing.
 */
export function maybeNotifyUpdate(deps: UpdateNotifierDeps = {}): void {
  const env = deps.env ?? process.env;
  if (env.DECX_NO_UPDATE_CHECK || env.CI || env.DECX_UPDATE_CHECK_CHILD) return;

  const version = deps.version ?? VERSION;
  if (!STABLE_VERSION_RE.test(version)) return;

  const logger = deps.logger ?? console;
  const cacheFile = deps.cacheFile ?? decxPath("update-check.json");
  const cache = readUpdateCheckCache(cacheFile);

  if (cache && compareSemver(cache.latestVersion, version) > 0) {
    logger.error(formatUpdateNotice(cache.latestVersion, version));
  }

  const now = deps.now ?? Date.now();
  if (cache && now - cache.lastCheck < UPDATE_CHECK_INTERVAL_MS) return;

  try {
    const entryFile = deps.entryFile ?? fileURLToPath(import.meta.url);
    const spawnImpl = deps.spawnImpl ?? spawn;
    const child = spawnImpl(process.execPath, [entryFile, "__update-check"], {
      detached: true,
      stdio: "ignore",
      env: { ...env, DECX_UPDATE_CHECK_CHILD: "1" },
    });
    child.unref();
  } catch {
    // A failed refresh must never break the actual command.
  }
}

/**
 * Background child entry point: fetch the latest stable version and rewrite
 * the cache. Failures leave the old cache untouched so the next run retries.
 */
export async function runUpdateCheck(
  deps: { fetchImpl?: typeof fetch; cacheFile?: string } = {},
): Promise<void> {
  const latestVersion = await fetchLatestStableVersion(deps.fetchImpl);
  if (!latestVersion) return;
  const cache: UpdateCheckCache = { lastCheck: Date.now(), latestVersion };
  atomicWriteJson(deps.cacheFile ?? decxPath("update-check.json"), cache);
}
