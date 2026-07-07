/**
 * Production packaging for @jygzyc/decx-agent.
 *
 * Pipeline:
 *   1. `tsc --noEmit` for type checking (fail fast on type errors).
 *   2. Clean dist/ and bundle src/index.ts with esbuild into a single
 *      minified, mangled ESM file. The four npm dependencies
 *      (commander, ai, @ai-sdk/openai, @ai-sdk/anthropic) and node:* builtins
 *      stay external so consumers' node_modules satisfy them.
 *   3. Verify the bundle boots: `node dist/index.js workers` must
 *      print valid JSON.
 *   4. `npm pack` the bundled dist into dist-packages/.
 *   5. Emit dist-packages/manifest.json with name, version, fileName,
 *      compressed size, unpacked size, sha256, and bundle metadata.
 *
 * No sourcemap is emitted — performance over debuggability.
 *
 * Idempotent. Runnable via `npm run pack`.
 */
import { build } from "esbuild";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = join(new URL("..", import.meta.url).pathname);
const srcEntry = join(root, "src", "cli.ts");
const distDir = join(root, "dist");
const distEntry = join(distDir, "index.js");
const outDir = join(root, "dist-packages");
const npmCache = mkdtempSync(join(tmpdir(), "decx-agent-npm-cache-"));

const EXTERNAL = [
  "commander",
  "ai",
  "@ai-sdk/openai",
  "@ai-sdk/anthropic",
];

try {
  await step("typecheck", () => {
    const result = spawnSync("npm", ["run", "typecheck"], {
      cwd: root,
      stdio: "inherit",
      env: npmEnv(),
    });
    if (result.status !== 0) {
      process.exit(result.status ?? 1);
    }
  });

  await step("clean dist", () => {
    rmSync(distDir, { recursive: true, force: true });
    mkdirSync(distDir, { recursive: true });
  });

  await step("copy dashboard.html", () => {
    copyFileSync(join(root, "src", "server", "dashboard.html"), join(distDir, "dashboard.html"));
  });

  await step("esbuild bundle", async () => {
    await build({
      entryPoints: [srcEntry],
      outfile: distEntry,
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
      external: EXTERNAL,
      minify: true,
      mangleProps: /^_/,
      legalComments: "none",
      treeShaking: true,
      keepNames: true,
      logLevel: "info",
      absWorkingDir: root,
    });
    try {
      chmodSync(distEntry, 0o755);
    } catch {
      // Best-effort; npm re-applies permissions on install.
    }
  });

  await step("verify bundle", () => {
    if (!existsSync(distEntry)) {
      process.stderr.write(`bundle did not produce ${distEntry}\n`);
      process.exit(1);
    }
    const verify = spawnSync("node", [distEntry, "workers"], {
      cwd: root,
      encoding: "utf-8",
      maxBuffer: 1024 * 1024 * 10,
      env: npmEnv(),
    });
    if (verify.status !== 0) {
      process.stderr.write("bundle verification failed: `node dist/index.js workers` exited non-zero\n");
      process.stderr.write(verify.stderr || verify.stdout);
      process.exit(verify.status ?? 1);
    }
    try {
      const parsed = JSON.parse(verify.stdout);
      if (!parsed || typeof parsed !== "object") {
        throw new Error("workers output is not a JSON object");
      }
    } catch (err) {
      process.stderr.write(`bundle verification: workers output is not valid JSON: ${err.message}\n`);
      process.exit(1);
    }
  });

  await step("npm pack", () => {
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });

    const packed = spawnSync(
      "npm",
      ["pack", "--pack-destination", outDir, "--json"],
      {
        cwd: root,
        encoding: "utf-8",
        maxBuffer: 1024 * 1024 * 10,
        env: npmEnv(),
      },
    );

    if (packed.status !== 0) {
      process.stderr.write(packed.stderr || packed.stdout);
      process.exit(packed.status ?? 1);
    }

    const [entry] = JSON.parse(packed.stdout);
    const fileName = entry.filename;
    const tarball = join(outDir, fileName);

    if (!existsSync(tarball)) {
      process.stderr.write(`expected compressed package at ${tarball}\n`);
      process.exit(1);
    }

    const bytes = readFileSync(tarball);
    const bundleBytes = statSync(distEntry).size;
    const manifest = {
      name: entry.name,
      version: entry.version,
      fileName,
      size: bytes.length,
      unpackedSize: entry.unpackedSize,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bundle: {
        entry: "src/index.ts",
        output: "dist/index.js",
        bundleBytes,
        external: EXTERNAL,
        format: "esm",
        platform: "node",
        target: "node22",
        minify: true,
        mangleProps: "^_",
        keepNames: true,
      },
    };

    writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  });
} finally {
  rmSync(npmCache, { recursive: true, force: true });
}

async function step(name, fn) {
  process.stdout.write(`[pack] ${name}...\n`);
  await fn();
}

function npmEnv() {
  return { ...process.env, npm_config_cache: npmCache };
}
