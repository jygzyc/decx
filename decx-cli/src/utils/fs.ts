import { mkdirSync, writeFileSync, renameSync } from "fs";
import * as path from "path";
import { randomBytes } from "crypto";

/**
 * Atomic write: write to temp file then rename (POSIX atomic).
 */
export function atomicWriteJson(filePath: string, data: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpFile = `${filePath}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmpFile, JSON.stringify(data, null, 2), "utf-8");
  renameSync(tmpFile, filePath);
}
