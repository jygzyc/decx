/**
 * `decx self install tai-e` backing logic.
 *
 * Installs the taint engine into DECX_HOME/tai-e:
 *   lib/decx-taint-*.jar + sootclasses-modified.jar + ...   (from the official
 *       Tai-e GitHub release zip; Tai-e is not on Maven Central)
 *   worker/decx-taint-worker.jar                             (DECX release asset)
 *
 * Not included (reported at the end):
 *   java-benchmarks/JREs/  — JRE libraries Tai-e loads relative to the worker
 *       working directory; clone https://github.com/pascal-lab/Tai-e and copy
 *       its java-benchmarks/JREs, or set them up per project.
 *   platforms/android-XX/   — Android SDK platform jars; fetch via the Android
 *       SDK manager and point target.platforms at them.
 */

import * as path from "path";
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from "fs";
import { downloadWithProgress } from "../utils/progress.js";
import { decxPath } from "./paths.js";
import { extractZipEntry, listZipEntries } from "../android/zip-utils.js";
import { VERSION } from "./version.js";

export const TAIE_VERSION = "0.5.4";
const TAIE_REPO = "pascal-lab/Tai-e";
const DECX_REPO = "jygzyc/decx";

export type InstallTaiEResult =
  | {
      ok: true;
      taieVersion: string;
      libDir: string;
      jarCount: number;
      workerJar?: string;
      workerJarMessage?: string;
      message: string;
    }
  | { ok: false; message: string };

interface InstallTaiEOptions {
  fetchImpl?: typeof fetch;
  downloadWithProgressImpl?: typeof downloadWithProgress;
  decxHomeDir?: string;
  taieVersion?: string;
  logger?: Pick<Console, "error">;
}

function taieZipUrl(version: string): string {
  return `https://github.com/${TAIE_REPO}/releases/download/v${version}/tai-e-${version}.zip`;
}

function workerJarUrl(version: string): string {
  return `https://github.com/${DECX_REPO}/releases/download/v${version}/decx-taint-worker.jar`;
}

async function downloadTo(
  fetchImpl: typeof fetch,
  downloadWithProgressImpl: typeof downloadWithProgress,
  url: string,
  targetPath: string,
  label: string,
): Promise<void> {
  const res = await fetchImpl(url, { redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new Error(`Download failed: HTTP ${res.status} for ${url}`);
  }
  const totalSize = Number(res.headers.get("content-length") || 0);
  await downloadWithProgressImpl(res.body, targetPath, totalSize, { label });
}

/**
 * Install the Tai-e taint engine (release jars + worker jar).
 *
 * `DECX_TAIE_ZIP=/path/to/tai-e-<version>.zip` bypasses the Tai-e download for
 * offline setups; the worker jar is best-effort (a clear fallback message is
 * returned when the DECX release does not carry the asset yet).
 */
export async function installTaiE(options: InstallTaiEOptions = {}): Promise<InstallTaiEResult> {
  const {
    fetchImpl = fetch,
    downloadWithProgressImpl = downloadWithProgress,
    decxHomeDir,
    taieVersion = TAIE_VERSION,
    logger = console,
  } = options;

  const taiEDir = path.join(decxHomeDir ?? decxPath(), "tai-e");
  const libDir = path.join(taiEDir, "lib");
  const workerDir = path.join(taiEDir, "worker");
  const libPrefix = `tai-e-${taieVersion}/lib/`;

  try {
    mkdirSync(libDir, { recursive: true });

    // ---- 1. Tai-e release zip -> lib/*.jar --------------------------------
    let jarCount = 0;
    let zipPath = process.env.DECX_TAIE_ZIP ?? "";
    const zipProvided = zipPath.length > 0 && existsSync(zipPath);
    if (!zipProvided) {
      zipPath = path.join(taiEDir, `.tai-e-${taieVersion}.zip.tmp`);
      logger.error(`  Downloading Tai-e v${taieVersion} release zip (~36 MB)...`);
      await downloadTo(fetchImpl, downloadWithProgressImpl, taieZipUrl(taieVersion), zipPath, `tai-e-${taieVersion}.zip`);
    }

    try {
      const libEntries = listZipEntries(zipPath).filter(
        (entry) => entry.startsWith(libPrefix) && entry.endsWith(".jar"),
      );
      if (libEntries.length === 0) {
        return { ok: false, message: `No jars under '${libPrefix}' in the Tai-e release zip` };
      }
      for (const entry of libEntries) {
        const target = path.join(libDir, entry.slice(libPrefix.length));
        const tmp = `${target}.tmp`;
        extractZipEntry(zipPath, entry, tmp);
        renameSync(tmp, target);
        jarCount += 1;
      }
    } finally {
      if (!zipProvided) {
        rmSync(zipPath, { force: true });
      }
    }

    // ---- 2. Worker jar (best-effort) --------------------------------------
    mkdirSync(workerDir, { recursive: true });
    const workerJarPath = path.join(workerDir, "decx-taint-worker.jar");
    let workerJar: string | undefined;
    let workerJarMessage: string | undefined;
    try {
      logger.error(`  Downloading decx-taint-worker.jar (release v${VERSION})...`);
      const tmp = `${workerJarPath}.tmp`;
      await downloadTo(fetchImpl, downloadWithProgressImpl, workerJarUrl(VERSION), tmp, "decx-taint-worker.jar");
      renameSync(tmp, workerJarPath);
      workerJar = workerJarPath;
    } catch (err) {
      workerJarMessage =
        `Worker jar not installed (${err instanceof Error ? err.message : String(err)}). ` +
        `Build it locally with 'cd decx && ./gradlew :decx-taint:dist' and copy ` +
        `decx/decx-taint/build/dist/decx-taint-worker.jar to ${workerJarPath}, ` +
        `or point DECX_TAINT_WORKER_JAR at it.`;
    }

    // ---- 3. Report what is still missing -----------------------------------
    const jresDir = path.join(taiEDir, "java-benchmarks", "JREs");
    const platformsDir = path.join(decxHomeDir ?? decxPath(), "platforms");
    const hasJres = existsSync(jresDir) && statSync(jresDir).isDirectory();
    const hasPlatforms = existsSync(platformsDir) && statSync(platformsDir).isDirectory();
    const missing: string[] = [];
    if (!hasJres) {
      missing.push(
        `JRE libraries: clone https://github.com/${TAIE_REPO} and copy its java-benchmarks/JREs to ${jresDir}`,
      );
    }
    if (!hasPlatforms) {
      missing.push(`Android platforms: place android-XX/android.jar dirs under ${platformsDir}`);
    }

    const parts = [
      `Installed Tai-e v${taieVersion} (${jarCount} jars) into ${libDir}`,
      workerJar ? `Installed worker jar to ${workerJar}` : workerJarMessage,
      ...missing.map((m) => `Still missing — ${m}`),
    ].filter((p): p is string => Boolean(p));

    return {
      ok: true,
      taieVersion,
      libDir,
      jarCount,
      ...(workerJar ? { workerJar } : {}),
      ...(workerJarMessage ? { workerJarMessage } : {}),
      message: parts.join("\n"),
    };
  } catch (err) {
    return { ok: false, message: `Tai-e installation failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
