#!/usr/bin/env node
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const profileDir = dirname(scriptsDir);
const knowledgeDir = join(profileDir, "knowledge-base");

console.log(JSON.stringify({
  profileDir,
  knowledgeDir,
  scriptsDir,
  scripts: readdirSync(scriptsDir).filter((name) => name.endsWith(".mjs")),
  knowledgeFiles: readdirSync(knowledgeDir).filter((name) => name.endsWith(".md")),
}, null, 2));
