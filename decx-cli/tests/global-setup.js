import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const decxRoot = path.join(repoRoot, "decx");
const testRoot = path.join(repoRoot, ".decx_test");
const testDecxHome = path.join(testRoot, "home", ".decx");
const testBinDir = path.join(testDecxHome, "bin");
const testServerJar = path.join(testBinDir, "decx-server.jar");

const distCandidates = [
  path.join(decxRoot, "dist"),
  path.join(decxRoot, "build", "dist"),
];

function findDistServerJar() {
  for (const dir of distCandidates) {
    if (!existsSync(dir)) continue;
    const jars = readdirSync(dir)
      .filter((name) => /^decx-server.*\.jar$/.test(name))
      .map((name) => path.join(dir, name))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    if (jars.length > 0) return jars[0];
  }
  return null;
}

function runGradleDist() {
  const result = spawnSync("./gradlew", ["clean", "dist"], {
    cwd: decxRoot,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`Failed to build DECX dist with ./gradlew clean dist (exit ${result.status})`);
  }
}

export default async function globalSetup() {
  mkdirSync(testBinDir, { recursive: true });

  let serverJar = findDistServerJar();
  if (!serverJar) {
    runGradleDist();
    serverJar = findDistServerJar();
  }

  if (!serverJar) {
    throw new Error(`DECX test setup could not find decx-server jar in ${distCandidates.join(" or ")}`);
  }

  copyFileSync(serverJar, testServerJar);
}
