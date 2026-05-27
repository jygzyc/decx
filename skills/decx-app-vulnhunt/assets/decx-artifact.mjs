#!/usr/bin/env node
/**
 * decx-artifact.mjs — Create analysis XML artifacts from template
 *
 * Usage:
 *   node decx-artifact.mjs <target-dir> <source-sig> <sink-sig> <flow-sig> <session> <kind>
 *
 * Arguments:
 *   target-dir   .decx-analysis/<target-name>/ directory
 *   source-sig   source component signature (e.g. "com.example.ExportActivity")
 *   sink-sig     sink component signature (e.g. "com.example.InternalActivity")
 *   flow-sig     current analyzed class-level signature
 *   session      DECX session name
 *   kind         "handoff" or "result"
 *
 * Examples:
 *   node decx-artifact.mjs .decx-analysis/myapp \
 *     "com.example.ExportActivity" "com.example.InternalActivity" \
 *     "com.example.ExportActivity" myapp handoff
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
  kind         "handoff" or "result"`);
  process.exit(1);
}

const [targetDir, sourceSig, sinkSig, flowSig, session, kind] = args;

if (kind !== "handoff" && kind !== "result") {
  console.error(`error: kind must be "handoff" or "result", got "${kind}"`);
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

const sourceId = toId(sourceSig);
const sinkId = toId(sinkSig);
const prefix = kind === "handoff" ? "h" : "r";
const flowSafe = safeFlow(flowSig);
const fileName = `${prefix}_${sourceId}_${sinkId}_${flowSafe}.xml`;

const scriptDir = dirname(fileURLToPath(import.meta.url));
const templatePath = join(scriptDir, "decx-analysis-template.xml");

let xml = readFileSync(templatePath, "utf-8");

xml = xml
  .replace(/<kind>handoff\|result<\/kind>/, `<kind>${kind}</kind>`)
  .replace(/<sourceId><\/sourceId>/, `<sourceId>${sourceId}</sourceId>`)
  .replace(/<sinkId><\/sinkId>/, `<sinkId>${sinkId}</sinkId>`)
  .replace(/<flowSig><\/flowSig>/, `<flowSig>${xmlEscape(flowSig)}</flowSig>`)
  .replace(/<fileName>[^<]*<\/fileName>/, `<fileName>${fileName}</fileName>`)
  .replace(
    /<decxSession>sessionName<\/decxSession>/,
    `<decxSession>${xmlEscape(session)}</decxSession>`
  )
  .replace(
    /(<entrypoint\s+[^>]*signature=")[^"]*(")/,
    `$1${xmlEscape(sourceSig)}$2`
  );

mkdirSync(targetDir, { recursive: true });
const outputPath = join(targetDir, fileName);
writeFileSync(outputPath, xml, "utf-8");
console.log(outputPath);
