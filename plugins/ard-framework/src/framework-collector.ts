/**
 * Framework collection from a connected Android device.
 *
 * Port of the Go `android.Collect` implementation (which superseded the TS
 * collector): the remote roots and their file filters are fixed, the runtime
 * `/apex` mount is scanned first so `/system/apex` images for modules it
 * already provides are skipped ("skippedCoveredModules"), and every pulled
 * file lands under the source directory mirroring its device path.
 */
import type { FrameworkLayout } from "./types";

const { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } = require("fs");
const path = require("path");

/** Minimal adb surface collection needs; the CLI injects the full client. */
interface AdbClient {
  shell(script: string): string;
  pull(remote: string, local: string): void;
}

/** Collection counters returned by `collectFramework`. */
interface CollectResult {
  scanned: number;
  pulled: number;
  skippedCoveredModules: number;
  failures: { path: string; error: string }[];
}

/** Scanned in this order; `/apex` covers activated modules before `/system/apex`. */
const FRAMEWORK_REMOTE_ROOTS = [
  "/system/framework",
  "/apex",
  "/vendor/framework",
  "/system_ext/framework",
  "/system/apex",
];

const APEX_IMAGE_EXTENSIONS = new Set([".apex", ".capex"]);
const DEX_CONTAINER_EXTENSIONS = new Set([".jar", ".apk", ".dex"]);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** True when `target` is `root` itself or nested inside it. */
function isInsideDir(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  if (relative === "") return true;
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/**
 * APEX module owning a path, taken from an `apex/<module>[/...]` segment.
 * Requires at least two path segments after "apex" so `/apex/foo` alone does
 * not count as a module directory.
 */
function remoteModule(remotePath: string): string {
  const parts = remotePath.replace(/^\/+/, "").split("/");
  for (let i = 0; i < parts.length; i += 1) {
    if (parts[i] === "apex" && i + 2 < parts.length) {
      return parts[i + 1].split("@")[0];
    }
  }
  return "";
}

/** A `.apex`/`.capex` whose base name is not a versioned module link. */
function isApexModuleImage(remotePath: string): boolean {
  const base = path.posix.basename(remotePath);
  const extension = path.posix.extname(base);
  const stem = base.slice(0, base.length - extension.length);
  return !stem.includes("@");
}

/** File filter per root: `/system/apex` keeps images, every other root keeps dex containers. */
function acceptsRemoteFile(root: string, remotePath: string): boolean {
  const extension = path.posix.extname(remotePath).toLowerCase();
  if (root === "/system/apex") {
    return APEX_IMAGE_EXTENSIONS.has(extension) && isApexModuleImage(remotePath);
  }
  return DEX_CONTAINER_EXTENSIONS.has(extension);
}

/** Module segment of an `.apex`/`.capex` path (`module@version.apex` → `module`). */
function apexModuleOf(remotePath: string): string {
  const base = path.posix.basename(remotePath);
  const extension = path.posix.extname(base);
  return base.slice(0, base.length - extension.length).split("@")[0];
}

/** Accepted remote files from one `find` invocation, in output order. */
function parseFrameworkFindOutput(root: string, output: string): string[] {
  const files = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const remote = rawLine.trim();
    if (!remote.startsWith(`${root}/`)) continue;
    if (!acceptsRemoteFile(root, remote)) continue;
    files.push(remote);
  }
  return files;
}

/**
 * Modules already present under `<sourceDir>/apex/...`, counted from files a
 * previous successful pull left behind.
 */
function scanCoveredModules(sourceDir: string): Set<string> {
  const covered = new Set<string>();
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const relative = path.relative(sourceDir, full).split(path.sep).join("/");
      const module = remoteModule(relative);
      if (module) covered.add(module);
    }
  };
  walk(path.join(sourceDir, "apex"));
  return covered;
}

function pullRemoteFile(
  adb: AdbClient,
  layout: FrameworkLayout,
  result: CollectResult,
  covered: Set<string>,
  remote: string,
): void {
  const clean = remote.replace(/^\/+/, "");
  const local = path.join(layout.sourceDir, ...clean.split("/"));
  if (!remote.startsWith("/") || !isInsideDir(layout.sourceDir, local)) {
    result.failures.push({ path: remote, error: "invalid device path" });
    return;
  }
  let tempDir: string | null = null;
  try {
    mkdirSync(path.dirname(local), { recursive: true });
    tempDir = mkdtempSync(path.join(path.dirname(local), ".pull-"));
    const tempPath = path.join(tempDir, "pull.tmp");
    adb.pull(remote, tempPath);
    renameSync(tempPath, local);
  } catch (error) {
    result.failures.push({ path: remote, error: errorMessage(error) });
    return;
  } finally {
    if (tempDir !== null) rmSync(tempDir, { recursive: true, force: true });
  }
  result.pulled += 1;
  const module = remoteModule(remote);
  if (module) covered.add(module);
}

function collectFramework(adb: AdbClient, layout: FrameworkLayout): CollectResult {
  const result: CollectResult = {
    scanned: 0,
    pulled: 0,
    skippedCoveredModules: 0,
    failures: [],
  };
  const covered = scanCoveredModules(layout.sourceDir);

  for (const root of FRAMEWORK_REMOTE_ROOTS) {
    // Missing OEM paths and inaccessible mounts are expected; fallback images
    // are scanned separately even when the runtime /apex scan is denied.
    const output = adb.shell(`find ${root} -type f 2>/dev/null; true`);
    for (const remote of parseFrameworkFindOutput(root, output)) {
      result.scanned += 1;
      if (root === "/system/apex" && covered.has(apexModuleOf(remote))) {
        result.skippedCoveredModules += 1;
        continue;
      }
      pullRemoteFile(adb, layout, result, covered, remote);
    }
  }
  return result;
}

module.exports = {
  FRAMEWORK_REMOTE_ROOTS,
  isInsideDir,
  remoteModule,
  isApexModuleImage,
  acceptsRemoteFile,
  apexModuleOf,
  parseFrameworkFindOutput,
  scanCoveredModules,
  collectFramework,
};
