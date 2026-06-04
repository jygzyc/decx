#!/usr/bin/env node

/**
 * DECX CLI build script.
 *
 * 1. tsc — emit .d.ts declarations only (no JS, no source maps)
 * 2. esbuild — bundle, minify, and compress into dist/
 * 3. Copy native binaries and gzip-compress them
 */

import { build } from "esbuild";
import { rmSync, readdirSync, statSync, cpSync, existsSync, readFileSync, writeFileSync, chmodSync } from "fs";
import { join, dirname } from "path";
import { execSync } from "child_process";
import { gzipSync } from "zlib";

const ROOT = join(dirname(new URL(import.meta.url).pathname), "..");
const DIST = join(ROOT, "dist");
const SRC = join(ROOT, "src");
const BIN = join(SRC, "bin");

// ── Step 1: Clean ──────────────────────────────────────────────────────────
rmSync(DIST, { recursive: true, force: true });

// ── Step 2: TypeScript declarations (d.ts only) ────────────────────────────
console.log("▸ Generating type declarations...");
execSync("npx tsc -p tsconfig.build.json --emitDeclarationOnly --declaration --declarationMap false", {
  cwd: ROOT,
  stdio: "pipe",
});

// Move .d.ts files from dist/src to dist/src (keep structure), remove JS
function removeJsFiles(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      removeJsFiles(full);
    } else if (entry.endsWith(".js")) {
      rmSync(full);
    }
  }
}
removeJsFiles(DIST);

// ── Step 3: esbuild — bundle & minify ──────────────────────────────────────
console.log("▸ Bundling with esbuild...");

const cliEntryPoint = join(SRC, "index.ts");
const sdkEntryPoint = join(SRC, "sdk", "index.ts");

// Read version for esbuild define
const pkgJson = JSON.parse(
  await import("fs").then(fs => fs.promises.readFile(join(ROOT, "package.json"), "utf-8"))
);

const esbuildOptions = {
  bundle: true,
  platform: "node",
  target: "node18",
  format: "esm",
  minify: true,
  treeShaking: true,
  packages: "external",
  sourcemap: false,
  legalComments: "none",
  logLevel: "info",
  define: {
    "process.env.npm_package_version": JSON.stringify(pkgJson.version),
  },
};

await build({
  ...esbuildOptions,
  entryPoints: [cliEntryPoint],
  outfile: join(DIST, "index.js"),
});

await build({
  ...esbuildOptions,
  entryPoints: [sdkEntryPoint],
  outfile: join(DIST, "sdk", "index.js"),
});

// ── Step 4: Copy package.json (production only) ────────────────────────────
console.log("▸ Copying package.json...");
// Keep only production fields
const prodPkg = {
  name: pkgJson.name,
  version: pkgJson.version,
  description: pkgJson.description,
  type: pkgJson.type,
  bin: { decx: "./index.js" },
  exports: pkgJson.exports,
  engines: pkgJson.engines,
  keywords: pkgJson.keywords,
  author: pkgJson.author,
  license: pkgJson.license,
  repository: pkgJson.repository,
  bugs: pkgJson.bugs,
  homepage: pkgJson.homepage,
  dependencies: { ...pkgJson.dependencies },
};
writeFileSync(join(DIST, "package.json"), JSON.stringify(prodPkg, null, 2) + "\n");

// ── Step 5: Copy native binaries and gzip-compress ────────────────────────
if (existsSync(BIN)) {
  cpSync(BIN, join(DIST, "bin"), { recursive: true });

  // Gzip all binary files in-place (replace .erofs/debugfs with .erofs.gz/debugfs.gz)
  const binDist = join(DIST, "bin");
  let compressedCount = 0;
  let totalBefore = 0;
  let totalAfter = 0;

  function gzipBinDir(dir) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        gzipBinDir(full);
      } else {
        // Only gzip actual binary files (not .gz, not .d.ts, etc.)
        if (entry.endsWith(".gz")) continue;
        const original = readFileSync(full);
        const compressed = gzipSync(original, { level: 9 });
        const gzPath = full + ".gz";
        writeFileSync(gzPath, compressed);
        chmodSync(gzPath, 0o644);
        rmSync(full);
        compressedCount++;
        totalBefore += original.length;
        totalAfter += compressed.length;
      }
    }
  }
  gzipBinDir(binDist);

  if (compressedCount > 0) {
    console.log(`▸ Compressed ${compressedCount} binaries: ${(totalBefore / 1024 / 1024).toFixed(1)}MB → ${(totalAfter / 1024 / 1024).toFixed(1)}MB (${Math.round((1 - totalAfter / totalBefore) * 100)}% reduction)`);
  }
}

// ── Done ───────────────────────────────────────────────────────────────────
console.log("✓ Build complete");
