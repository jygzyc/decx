/**
 * Sync the Claude plugin version (.claude-plugin/plugin.json and
 * .claude-plugin/marketplace.json) with the repository `version` file.
 *
 * Idempotent: writes files only when the versions differ, so the workflow
 * can run on every relevant push without producing empty commits.
 */

import { readFileSync, writeFileSync } from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function readVersion() {
  const version = readFileSync(path.join(repoRoot, "version"), "utf-8").trim();
  if (!/^\d+\.\d+\.\d+/.test(version)) {
    throw new Error(`Invalid version file content: '${version}'`);
  }
  return version;
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf-8"));
}

function writeJson(filePath, data) {
  writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

const version = readVersion();
const pluginPath = path.join(repoRoot, ".claude-plugin", "plugin.json");
const marketplacePath = path.join(repoRoot, ".claude-plugin", "marketplace.json");

const plugin = readJson(pluginPath);
const marketplace = readJson(marketplacePath);

let changed = false;

if (plugin.version !== version) {
  plugin.version = version;
  changed = true;
}

for (const entry of marketplace.plugins ?? []) {
  if (entry.name === "decx" && entry.version !== version) {
    entry.version = version;
    changed = true;
  }
}

if (changed) {
  writeJson(pluginPath, plugin);
  writeJson(marketplacePath, marketplace);
  console.log(`Updated Claude plugin version to ${version}`);
} else {
  console.log("Claude plugin version already in sync");
}
