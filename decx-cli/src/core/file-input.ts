import { createHash } from "crypto";
import { existsSync, mkdirSync } from "fs";
import * as path from "path";
import { downloadWithProgress, formatBytes } from "../utils/progress.js";
import { FileError } from "../utils/errors.js";
import { decxPath } from "./paths.js";

const URL_RE = /^https?:\/\//i;

export async function resolveFileInput(input: string): Promise<string> {
  if (!URL_RE.test(input)) {
    return path.resolve(input);
  }

  const tmpDir = decxPath("tmp");
  mkdirSync(tmpDir, { recursive: true });

  const url = new URL(input);
  const urlHash = createHash("md5").update(input).digest("hex").slice(0, 8);
  let filename = path.basename(url.pathname);
  if (!/\.(apk|dex|jar|class|aar)$/i.test(filename)) {
    filename = `${filename}_${urlHash}.bin`;
  } else {
    filename = `${urlHash}_${filename}`;
  }
  const localPath = path.join(tmpDir, filename);

  if (existsSync(localPath)) {
    return localPath;
  }

  console.error(`  Downloading ${input} ...`);

  const response = await fetch(input, { redirect: "follow" });
  if (!response.ok) {
    throw new FileError(`Download failed: HTTP ${response.status}`, input);
  }
  if (!response.body) {
    throw new FileError("Download failed: empty response body", input);
  }

  const totalSize = Number(response.headers.get("content-length") || 0);
  const downloaded = await downloadWithProgress(
    response.body,
    localPath,
    totalSize,
    { label: path.basename(input) },
  );
  console.error(`  Saved to ${localPath} (${formatBytes(downloaded)})`);

  return localPath;
}
