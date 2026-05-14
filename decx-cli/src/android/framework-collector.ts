import { mkdirSync } from "fs";
import * as path from "path";
import { AdbClient } from "./adb.js";
import type { FrameworkCollectionResult, FrameworkOem } from "./types.js";

const OEM_DIRS: Record<FrameworkOem, string[]> = {
  vivo: ["/system/framework", "/system/apex", "/vendor/framework", "/system_ext/framework"],
  oppo: ["/system/framework", "/system/apex", "/system_ext/framework"],
  xiaomi: ["/system/framework", "/system/apex", "/system_ext/framework", "/vendor/framework"],
  honor: ["/system/framework", "/system/apex", "/vendor/framework", "/system_ext/framework"],
  google: ["/system/framework", "/system/apex", "/vendor/framework", "/system_ext/framework"],
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

  for (const remotePath of remoteFiles) {
    const localPath = path.join(sourceDir, remotePath.replace(/^\/+/, ""));
    mkdirSync(path.dirname(localPath), { recursive: true });
    try {
      adb.pull(remotePath, localPath);
      files.push(localPath);
    } catch (error) {
      failures.push({
        path: remotePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    scanned: remoteFiles.length,
    pulled: files.length,
    failed: failures.length,
    files,
    failures,
  };
}
