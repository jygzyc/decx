import { existsSync, readFileSync } from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

export const VERSION = process.env.DECX_PROJECT_VERSION ?? readVersionFile() ?? "dev";

function readVersionFile(startDir: string = path.dirname(fileURLToPath(import.meta.url))): string | null {
  let dir: string | undefined = startDir;
  while (dir) {
    const file = path.join(dir, "version");
    if (existsSync(file)) {
      const version = readFileSync(file, "utf-8").trim();
      return version.length > 0 ? version : null;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
