import { mkdirSync, rmSync } from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = path.resolve(__dirname, "..", "..");
export const DECX_TEST_ROOT = path.join(REPO_ROOT, ".decx_test");
export const DECX_TEST_HOME = path.join(DECX_TEST_ROOT, "home");
export const DECX_TEST_DECX_HOME = path.join(DECX_TEST_HOME, ".decx");
export const DECX_TEST_TMP = path.join(DECX_TEST_ROOT, "tmp");
export const DECX_TEST_INSTALL = path.join(DECX_TEST_ROOT, "install");
export const DECX_TEST_SERVER_HOME = path.join(DECX_TEST_DECX_HOME, "bin");
export const DECX_TEST_SERVER_JAR = path.join(DECX_TEST_SERVER_HOME, "decx-server.jar");

export function ensureDecxTestDirs(): void {
  mkdirSync(DECX_TEST_HOME, { recursive: true });
  mkdirSync(DECX_TEST_DECX_HOME, { recursive: true });
  mkdirSync(DECX_TEST_SERVER_HOME, { recursive: true });
  mkdirSync(DECX_TEST_TMP, { recursive: true });
  mkdirSync(DECX_TEST_INSTALL, { recursive: true });
}

export function resetTestDir(...parts: string[]): string {
  const dir = path.join(DECX_TEST_ROOT, ...parts);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function testPath(...parts: string[]): string {
  ensureDecxTestDirs();
  return path.join(DECX_TEST_ROOT, ...parts);
}
