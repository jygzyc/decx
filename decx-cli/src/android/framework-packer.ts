import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "fs";
import * as path from "path";
import { randomBytes } from "crypto";
import { spawnSync } from "child_process";
import { FileError } from "../utils/errors.js";
import type { FrameworkPackResult, FrameworkPathLayout } from "./types.js";

const FRAMEWORK_MANIFEST = `Manifest-Version: 1.0
Created-By: decx
`;

function countFiles(dir: string): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += countFiles(fullPath);
    } else {
      total += 1;
    }
  }
  return total;
}

function collectFiles(dir: string, found: string[] = []): string[] {
  if (!existsSync(dir)) return found;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(fullPath, found);
    } else {
      found.push(fullPath);
    }
  }
  return found;
}

export async function packFrameworkJar(layout: FrameworkPathLayout): Promise<FrameworkPackResult> {
  const fileCount = countFiles(layout.outTmpDir);
  if (fileCount === 0) {
    throw new FileError(`No processed files found in ${layout.outTmpDir}`);
  }

  const stagingDir = path.join(layout.outDir, `.pack_tmp_${randomBytes(4).toString("hex")}`);
  const manifestDir = path.join(stagingDir, "META-INF");
  const stagedFiles = collectFiles(layout.outTmpDir);

  mkdirSync(manifestDir, { recursive: true });
  writeFileSync(path.join(manifestDir, "MANIFEST.MF"), FRAMEWORK_MANIFEST, "utf-8");
  for (const filePath of stagedFiles) {
    copyFileSync(filePath, path.join(stagingDir, path.basename(filePath)));
  }

  const result = spawnSync(
    "zip",
    ["-q", "-r", layout.jarPath, "META-INF", ...stagedFiles.map((filePath) => path.basename(filePath))],
    {
      cwd: stagingDir,
      encoding: "utf-8",
    },
  );

  rmSync(stagingDir, { recursive: true, force: true });

  if (result.error) {
    throw new FileError(`Failed to execute zip: ${result.error.message}`);
  }

  if (result.status !== 0) {
    throw new FileError(result.stderr?.trim() || result.stdout?.trim() || "Failed to create out.jar");
  }

  return {
    ok: true,
    jarPath: layout.jarPath,
    fileCount,
  };
}
