#!/usr/bin/env node
/**
 * decx-artifact.mjs — Create analysis XML artifacts from template
 *
 * Usage:
 *   node decx-artifact.mjs <target-dir> <source-sig> <sink-sig> <flow-sig> <session> <kind>
 *   node decx-artifact.mjs <target-dir> "" "" "" <session> handoff-session
 *
 * Arguments:
 *   target-dir   .decx-analysis/<target-name>/ directory
 *   source-sig   source component signature (e.g. "android.app.IActivityManager.startActivity")
 *   sink-sig     sink component signature (e.g. "ActivityTaskManagerService.startActivityAsUser")
 *   flow-sig     current analyzed class-level signature
 *   session      DECX session name
 *   kind         "handoff", "result", or "handoff-session"
 *
 * Examples:
 *   node decx-artifact.mjs .decx-analysis/myapp \
 *     "android.app.IActivityManager.startActivity" "ActivityTaskManagerService.startActivityAsUser" \
 *     "com.android.server.wm.ActivityTaskManagerService" framework handoff
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
if (args.length < 6) {
  console.log(`Usage: node decx-artifact.mjs <target-dir> <source-sig> <sink-sig> <flow-sig> <session> <kind>

  target-dir   .decx-analysis/<target-name>/ directory
  source-sig   source component signature
  sink-sig     sink component signature
  flow-sig     current analyzed class-level signature
  session      DECX session name
  kind         "handoff", "result", or "handoff-session"`);
  process.exit(1);
}

const [targetDir, sourceSig, sinkSig, flowSig, session, kind] = args;

if (kind !== "handoff" && kind !== "result" && kind !== "handoff-session") {
  console.error(`error: kind must be "handoff", "result", or "handoff-session", got "${kind}"`);
  process.exit(1);
}

function toId(sig) {
  return Buffer.from(sig).toString("base64url");
}

function safeFlow(sig) {
  return sig.replace(/[.;$\/]/g, "_");
}

function xmlEscape(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const isSessionHandoff = kind === "handoff-session";
const sourceId = isSessionHandoff ? "" : toId(sourceSig);
const sinkId = isSessionHandoff ? "" : toId(sinkSig);
const prefix = kind === "result" ? "r" : "h";
const flowSafe = safeFlow(flowSig);
const fileName = isSessionHandoff
  ? `h_${safeFlow(session)}.xml`
  : `${prefix}_${sourceId}_${sinkId}_${flowSafe}.xml`;

const scriptDir = dirname(fileURLToPath(import.meta.url));
const templatePath = join(scriptDir, "decx-analysis-template.xml");

let xml = readFileSync(templatePath, "utf-8");

xml = xml
  .replace(/<kind>handoff\|result<\/kind>/, `<kind>${isSessionHandoff ? "handoff" : kind}</kind>`)
  .replace(/<sourceId><\/sourceId>/, `<sourceId>${sourceId}</sourceId>`)
  .replace(/<sinkId><\/sinkId>/, `<sinkId>${sinkId}</sinkId>`)
  .replace(/<flowSig><\/flowSig>/, `<flowSig>${xmlEscape(isSessionHandoff ? "session" : flowSig)}</flowSig>`)
  .replace(/<fileName>[^<]*<\/fileName>/, `<fileName>${fileName}</fileName>`)
  .replace(
    /<decxSession>sessionName<\/decxSession>/,
    `<decxSession>${xmlEscape(session)}</decxSession>`
  )
  .replace(
    /(<entrypoint\s+[^>]*signature=")[^"]*(")/,
    `$1${xmlEscape(isSessionHandoff ? session : sourceSig)}$2`
  );

mkdirSync(targetDir, { recursive: true });
const outputPath = join(targetDir, fileName);
writeFileSync(outputPath, xml, "utf-8");
console.log(outputPath);
