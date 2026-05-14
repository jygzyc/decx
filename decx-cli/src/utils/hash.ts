/**
 * File hashing utilities.
 */

import { createHash } from "crypto";
import { createReadStream } from "fs";

const MAX_BYTES = 100 * 1024 * 1024; // 100MB

/**
 * Async file hash — does NOT block the event loop.
 * Returns first 16 hex chars of SHA-256.
 */
export async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  let totalRead = 0;

  const stream = createReadStream(filePath, {
    highWaterMark: 64 * 1024,
  });

  for await (const chunk of stream as AsyncIterable<Buffer>) {
    hash.update(chunk);
    totalRead += chunk.length;
    if (totalRead >= MAX_BYTES) {
      stream.destroy();
      break;
    }
  }

  return hash.digest("hex").slice(0, 16);
}
