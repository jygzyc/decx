/**
 * Download progress indicator utility.
 */

import { createWriteStream } from "fs";
import pc from "picocolors";

export interface DownloadProgressOptions {
  /** Label shown before the progress bar */
  label?: string;
  /** Width of the progress bar in characters (default: 30) */
  barWidth?: number;
}

/**
 * Download a response body to a file with progress indication.
 * Returns the total bytes downloaded.
 */
export async function downloadWithProgress(
  body: ReadableStream<Uint8Array>,
  filePath: string,
  totalSize: number,
  options: DownloadProgressOptions = {}
): Promise<number> {
  const { label = "Downloading", barWidth = 30 } = options;

  const fileStream = createWriteStream(filePath);
  let downloaded = 0;
  let lastPercent = -1;

  for await (const chunk of body as AsyncIterable<Buffer>) {
    fileStream.write(chunk);
    downloaded += chunk.length;

    if (totalSize > 0) {
      const pct = Math.round((downloaded / totalSize) * 100);
      if (pct !== lastPercent) {
        lastPercent = pct;
        const filled = Math.round((pct / 100) * barWidth);
        const empty = barWidth - filled;
        process.stderr.write(
          `\r  ${label} [${pc.green("#".repeat(filled))}${pc.dim("-".repeat(empty))}] ${pct}% (${formatBytes(downloaded)} / ${formatBytes(totalSize)})`
        );
      }
    }
  }

  if (totalSize > 0) {
    process.stderr.write("\n");
  }

  await new Promise<void>((resolve, reject) => {
    fileStream.end(() => resolve());
    fileStream.on("error", reject);
  });

  return downloaded;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
