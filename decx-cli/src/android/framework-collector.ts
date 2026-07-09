import { copyFileSync, mkdirSync, renameSync, rmSync } from "fs";
import { randomBytes } from "crypto";
import * as path from "path";
import { AdbClient } from "./adb.js";
import type { FrameworkCollectionResult, FrameworkOem } from "./types.js";

const OEM_DIRS: Record<FrameworkOem, string[]> = {
  vivo: ["/system/framework", "/system/apex", "/vendor/framework", "/system_ext/framework"],
  oppo: ["/system/framework", "/system/apex", "/system_ext/framework"],
  xiaomi: ["/system/framework", "/system/apex", "/system_ext/framework", "/vendor/framework"],
  honor: ["/system/framework", "/system/apex", "/vendor/framework", "/system_ext/framework"],
  google: ["/system/framework", "/system/apex", "/vendor/framework", "/system_ext/framework"],
  samsung: ["/system/framework", "/system/apex", "/vendor/framework", "/system_ext/framework"]
};

const FILE_TYPES = [".apk", ".jar", ".apex", ".capex", ".dex"];

function isFrameworkOem(value: string): value is FrameworkOem {
  return Object.prototype.hasOwnProperty.call(OEM_DIRS, value);
}

export function normalizeOem(value: string): FrameworkOem {
  const lowered = value.toLowerCase();
  if (!isFrameworkOem(lowered)) {
    throw new Error(`Unsupported OEM '${value}'. Supported: ${Object.keys(OEM_DIRS).join(", ")}`);
  }
  return lowered;
}

function buildFindCommand(searchPaths: string[]): string {
  const nameConditions = FILE_TYPES.map((fileType) => `-name '*${fileType}'`).join(" -o ");
  return searchPaths.map((searchPath) => `find ${searchPath} -type f \\( ${nameConditions} \\)`).join(" ; ");
}

function filterScanOutput(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !line.includes("Permission denied") && !line.includes("No such file"));
}

export function getOemSearchPaths(oem: FrameworkOem): string[] {
  return OEM_DIRS[oem];
}

export async function collectFrameworkFiles(
  adb: AdbClient,
  oem: FrameworkOem,
  sourceDir: string,
): Promise<FrameworkCollectionResult> {
  const remoteFiles = filterScanOutput(adb.shell(buildFindCommand(getOemSearchPaths(oem))));
  const files: string[] = [];
  const failures: Array<{ path: string; error: string }> = [];

  // Stage pulls in a CWD-relative dir so the local path handed to adb is never
  // an absolute POSIX path. This sidesteps the WSL case where the resolved adb
  // is the Windows adb.exe, which cannot interpret /mnt/<drive>/... paths and
  // fails with "cannot create file/directory: No such file or directory". A
  // relative path resolves identically for both WSL-Node and Windows adb.exe
  // (both inherit this process' working directory). Files are then relocated to
  // their final nested POSIX target under sourceDir via Node's fs.
  const stagingDir = `.decx_pull_tmp_${randomBytes(4).toString("hex")}`;
  mkdirSync(stagingDir, { recursive: true });

  try {
    remoteFiles.forEach((remotePath, index) => {
      const localPath = path.join(sourceDir, remotePath.replace(/^\/+/, ""));
      // Flat, collision-free staging name (device file names can repeat across
      // subtrees, so prefix with the iteration index).
      const stagedName = `file_${index.toString().padStart(4, "0")}_${path.basename(remotePath)}`;
      const stagedFile = path.join(stagingDir, stagedName);
      try {
        adb.pull(remotePath, stagedFile);
        mkdirSync(path.dirname(localPath), { recursive: true });
        moveFile(stagedFile, localPath);
        files.push(localPath);
      } catch (error) {
        // Best-effort cleanup of a half-pulled staged file so it can't leak.
        rmSync(stagedFile, { force: true });
        failures.push({
          path: remotePath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }

  return {
    scanned: remoteFiles.length,
    pulled: files.length,
    failed: failures.length,
    files,
    failures,
  };
}

/**
 * Move a file, falling back to copy+delete across filesystems.
 * renameSync is atomic and preferred, but throws EXDEV when source and
 * destination live on different mounts (e.g. CWD on one drive, sourceDir on
 * another). The codebase had no cross-device move helper, so it lives here.
 */
function moveFile(source: string, destination: string): void {
  try {
    renameSync(source, destination);
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "EXDEV") {
      copyFileSync(source, destination);
      rmSync(source, { force: true });
      return;
    }
    throw error;
  }
}
