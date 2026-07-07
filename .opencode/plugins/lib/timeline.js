import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { MAX_TIMELINE_BUFFER, TIMELINE_DIR } from "./constants.js";
import { debugLog } from "./logging.js";

const buffers = new Map();

function format(event) {
  return JSON.stringify({ ts: event.timestamp, ...event });
}

export function recordTimeline(sessionID, event, flush = false) {
  if (!sessionID) return;
  let buffer = buffers.get(sessionID);
  if (!buffer) {
    buffer = [];
    buffers.set(sessionID, buffer);
  }
  buffer.push({ timestamp: Date.now(), ...event });
  if (flush || buffer.length >= MAX_TIMELINE_BUFFER) flushTimeline(sessionID);
}

export function flushTimeline(sessionID) {
  const buffer = buffers.get(sessionID);
  if (!buffer?.length) return;
  try {
    mkdirSync(TIMELINE_DIR, { recursive: true });
    writeFileSync(join(TIMELINE_DIR, `${sessionID}.jsonl`), buffer.map(format).join("\n") + "\n", { flag: "a" });
    buffer.length = 0;
  } catch (error) {
    debugLog(`flushTimeline failed: ${error}`, sessionID);
  }
}
