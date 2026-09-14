/**
 * Framework jar packing.
 *
 * Port of the Go `android.Pack`: the packed jar contains a minimal manifest
 * plus one entry per processed dex file, named by its basename. The archive is
 * built by the platform zip tool (see zip-utils.js); the previous jar is only
 * replaced once the new archive exists.
 */
import type { FrameworkLayout } from "./types";

const { copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } = require("fs");
const path = require("path");
const { createZipArchive } = require("./zip-utils.js");
const { FileError } = require("./errors.js");
const { walkFrameworkInputs } = require("./framework-processor.js");

const FRAMEWORK_MANIFEST = "Manifest-Version: 1.0\r\nCreated-By: decx\r\n\r\n";
const FRAMEWORK_MANIFEST_PATH = "META-INF/MANIFEST.MF";

function createFrameworkManifest(root: string): string {
  const directory = path.join(root, "META-INF");
  mkdirSync(directory, { recursive: true });
  const manifest = path.join(root, ...FRAMEWORK_MANIFEST_PATH.split("/"));
  writeFileSync(manifest, FRAMEWORK_MANIFEST, "utf-8");
  return manifest;
}

/**
 * Packs the processed dex files into `layout.artifact.jarPath` and returns it.
 * Fails when there is nothing to pack, leaving any previous jar untouched.
 */
function packFrameworkJar(layout: FrameworkLayout): string {
  const files = walkFrameworkInputs(layout.outTmpDir);
  if (files.length === 0) {
    throw new FileError("no processed dex files", layout.outTmpDir);
  }
  const staging = mkdtempSync(path.join(layout.outDir, ".pack-"));
  try {
    createFrameworkManifest(staging);
    const entries = ["META-INF"];
    for (const file of files) {
      const name = path.basename(file);
      copyFileSync(file, path.join(staging, name));
      entries.push(name);
    }
    const archive = path.join(staging, "framework.jar");
    createZipArchive(archive, entries, staging);
    rmSync(layout.artifact.jarPath, { force: true });
    renameSync(archive, layout.artifact.jarPath);
    return layout.artifact.jarPath;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

module.exports = { FRAMEWORK_MANIFEST, FRAMEWORK_MANIFEST_PATH, createFrameworkManifest, packFrameworkJar };
