#!/usr/bin/env node
/**
 * Decode metadata from a DECX analysis artifact filename.
 *
 * Usage:
 *   node decode-artifact-name.mjs <h_or_r_artifact.xml>
 *
 * Output:
 *   JSON for either session handoff or source/sink/flow artifact.
 */

import { basename } from "node:path";

const [artifactPath] = process.argv.slice(2);

if (!artifactPath) {
  console.error("Usage: node decode-artifact-name.mjs <h_or_r_artifact.xml>");
  process.exit(1);
}

const fileName = basename(artifactPath);
const sessionMatch = /^h_([^_]+)\.xml$/.exec(fileName);

if (sessionMatch) {
  const [, sessionName] = sessionMatch;
  console.log(JSON.stringify({
    kind: "handoff",
    scope: "session",
    sessionName,
  }, null, 2));
  process.exit(0);
}

const match = /^(h|r)_([^_]+)_([^_]+)_(.+)\.xml$/.exec(fileName);

if (!match) {
  console.error(
    `error: expected h_<sessionName>.xml, h_<sourceId>_<sinkId>_<flowSig>.xml, or r_<sourceId>_<sinkId>_<flowSig>.xml, got "${fileName}"`
  );
  process.exit(1);
}

const [, prefix, sourceId, sinkId, flowSig] = match;

function decodeBase64Url(id, label) {
  try {
    return Buffer.from(id, "base64url").toString("utf8");
  } catch (err) {
    console.error(`error: failed to decode ${label} "${id}": ${err.message}`);
    process.exit(1);
  }
}

const result = {
  kind: prefix === "h" ? "handoff" : "result",
  sourceId,
  source: decodeBase64Url(sourceId, "sourceId"),
  sinkId,
  sink: decodeBase64Url(sinkId, "sinkId"),
  flowSig,
};

console.log(JSON.stringify(result, null, 2));
