import AdmZip from "adm-zip";
import { existsSync, readdirSync } from "fs";
import * as path from "path";
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

  // Build the jar in memory with adm-zip instead of shelling out to `zip`.
  // addLocalFile uses each file's basename as the entry name, so the packed
  // jar has a flat layout rooted at the jar root — same shape as the old
  // staging-dir + `zip -r` flow, without the temp dir or PATH dependency.
  const zip = new AdmZip();
  zip.addFile("META-INF/MANIFEST.MF", Buffer.from(FRAMEWORK_MANIFEST, "utf-8"));
  for (const filePath of collectFiles(layout.outTmpDir)) {
    zip.addLocalFile(filePath);
  }
  zip.writeZip(layout.jarPath);

  return {
    ok: true,
    jarPath: layout.jarPath,
    fileCount,
  };
}
