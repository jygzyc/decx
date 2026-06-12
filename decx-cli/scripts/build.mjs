#!/usr/bin/env node

/**
 * DECX CLI build script.
 *
 * 1. tsc — type-check only (no JS, declarations, or source maps)
 * 2. esbuild — bundle CLI and SDK into two partially obfuscated index files
 * 3. Pack native binaries into one compressed archive
 */

import { build } from "esbuild";
import { rmSync, readdirSync, statSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { execSync } from "child_process";

const ROOT = join(dirname(new URL(import.meta.url).pathname), "..");
const REPO_ROOT = join(ROOT, "..");
const DIST = join(ROOT, "dist");
const SRC = join(ROOT, "src");
const BIN = join(SRC, "bin");
const projectVersion = readVersionFile();
const npmPackageVersion = projectVersion.replace(/^v/, "");

// ── Step 1: Clean ──────────────────────────────────────────────────────────
rmSync(DIST, { recursive: true, force: true });

// ── Step 2: TypeScript type-check ──────────────────────────────────────────
console.log("▸ Type-checking...");
execSync("npx tsc -p tsconfig.build.json --noEmit", {
  cwd: ROOT,
  stdio: "pipe",
});

// ── Step 3: esbuild — bundle & minify ──────────────────────────────────────
console.log("▸ Bundling with esbuild...");

const cliEntryPoint = join(SRC, "index.ts");
const sdkEntryPoint = join(SRC, "sdk", "index.ts");

const pkgJson = JSON.parse(
  await import("fs").then(fs => fs.promises.readFile(join(ROOT, "package.json"), "utf-8"))
);

const esbuildOptions = {
  bundle: true,
  platform: "node",
  target: "node18",
  format: "esm",
  minify: true,
  mangleProps: /^_/,
  mangleQuoted: false,
  reserveProps: /^__(.*)|^_events$|^_eventsCount$|^_maxListeners$/,
  treeShaking: true,
  sourcemap: false,
  legalComments: "none",
  logLevel: "info",
  banner: {
    js: "import { createRequire } from 'module';const require=createRequire(import.meta.url);",
  },
  define: {
    "process.env.DECX_PROJECT_VERSION": JSON.stringify(projectVersion),
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
const prodExports = {
  ".": {
    import: "./index.js",
  },
  "./sdk": {
    import: "./sdk/index.js",
  },
};

const prodPkg = {
  name: pkgJson.name,
  version: npmPackageVersion,
  description: pkgJson.description,
  type: pkgJson.type,
  bin: { decx: "./index.js" },
  exports: prodExports,
  engines: pkgJson.engines,
  keywords: pkgJson.keywords,
  author: pkgJson.author,
  license: pkgJson.license,
  repository: pkgJson.repository,
  bugs: pkgJson.bugs,
  homepage: pkgJson.homepage,
};
writeFileSync(join(DIST, "package.json"), JSON.stringify(prodPkg, null, 2) + "\n");

// ── Step 5: Pack native binaries ──────────────────────────────────────────
if (existsSync(BIN)) {
  console.log("▸ Packing native binaries...");
  mkdirSync(DIST, { recursive: true });

  function dirSize(dir) {
    let total = 0;
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        total += dirSize(full);
      } else {
        total += stat.size;
      }
    }
    return total;
  }

  const archive = join(DIST, "bin.tar.gz");
  execSync(`tar -czf ${JSON.stringify(archive)} -C ${JSON.stringify(BIN)} .`, {
    cwd: ROOT,
    stdio: "pipe",
  });

  const totalBefore = dirSize(BIN);
  const totalAfter = statSync(archive).size;
  console.log(`▸ Packed binaries: ${(totalBefore / 1024 / 1024).toFixed(1)}MB → ${(totalAfter / 1024 / 1024).toFixed(1)}MB (${Math.round((1 - totalAfter / totalBefore) * 100)}% reduction)`);
}

// ── Done ───────────────────────────────────────────────────────────────────
console.log("✓ Build complete");

function readVersionFile() {
  const versionPath = join(REPO_ROOT, "version");
  if (!existsSync(versionPath)) {
    throw new Error(`Missing version file: ${versionPath}`);
  }
  const version = readFileSync(versionPath, "utf-8").trim();
  if (!version) {
    throw new Error(`Empty version file: ${versionPath}`);
  }
  return version;
}
