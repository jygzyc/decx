import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = join(new URL("..", import.meta.url).pathname);
const outDir = join(root, "dist-packages");
const npmCache = mkdtempSync(join(tmpdir(), "decx-agent-npm-cache-"));

try {
  run("npm", ["run", "build"]);

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const packed = spawnSync("npm", ["pack", "--pack-destination", outDir, "--json"], {
    cwd: root,
    encoding: "utf-8",
    maxBuffer: 1024 * 1024 * 10,
    env: npmEnv(),
  });

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
  const manifest = {
    name: entry.name,
    version: entry.version,
    fileName,
    size: bytes.length,
    unpackedSize: entry.unpackedSize,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };

  writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
} finally {
  rmSync(npmCache, { recursive: true, force: true });
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    env: npmEnv(),
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function npmEnv() {
  return { ...process.env, npm_config_cache: npmCache };
}
