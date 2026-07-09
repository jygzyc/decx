#!/usr/bin/env node

/**
 * PoC project bootstrap script.
 *
 * Usage: node setup-poc.mjs <target-app>
 *
 * Copies the split PoC template and replaces placeholders (longest match first):
 *   com.poc.targetapp -> com.poc.<target-app>
 *   poc-targetapp     -> poc-<target-app>
 *   targetapp         -> <target-app>
 */

import { cpSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname, basename, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PLACEHOLDER_PKG = 'com.poc.targetapp';
const PLACEHOLDER_PROJ = 'poc-targetapp';


const GENERATED_NAMES = new Set(['.gradle', 'build', 'out']);

function shouldCopy(src) {
  return !src.split(sep).some((part) => GENERATED_NAMES.has(part));
}

const TEXT_EXT = new Set([
  '.java', '.kt', '.xml', '.gradle', '.kts', '.properties', '.toml',
  '.md', '.txt', '.pro', '.html', '.js', '.css', '.mjs', '.json',
]);

function usage() {
  process.stderr.write('Usage: node setup-poc.mjs <target-app>\n');
  process.stderr.write('  node setup-poc.mjs myapp   -> creates poc-myapp/, package com.poc.myapp\n');
}

export function isValidAppName(name) {
  return Boolean(name) && /^[a-z][a-z0-9]*$/.test(name);
}

function walkAndReplace(dir, replacements) {
  let changed = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      changed += walkAndReplace(fullPath, replacements);
      renameIfNeeded(fullPath, replacements);
    } else if (TEXT_EXT.has(extname(fullPath))) {
      let content = readFileSync(fullPath, 'utf-8');
      for (const [from, to] of replacements) {
        if (content.includes(from)) {
          content = content.replaceAll(from, to);
          changed++;
        }
      }
      writeFileSync(fullPath, content, 'utf-8');
      renameIfNeeded(fullPath, replacements);
    }
  }
  return changed;
}

function renameIfNeeded(filePath, replacements) {
  let name = basename(filePath);
  for (const [from, to] of replacements) {
    if (name.includes(from)) name = name.replaceAll(from, to);
  }
  if (name !== basename(filePath)) {
    renameSync(filePath, join(dirname(filePath), name));
  }
}

export function createPocProject({ appName, cwd = process.cwd() }) {
  if (!isValidAppName(appName)) {
    throw new Error(`invalid app name "${appName}". Use lowercase letters or digits, starting with a letter.`);
  }

  const newPkg = `com.poc.${appName}`;
  const projectDir = join(cwd, `poc-${appName}`);
  const appTpl = join(__dirname, '..', 'assets', 'poc-template-app');
  const serverTpl = join(__dirname, '..', 'assets', 'poc-template-server');

  if (!statSync(appTpl).isDirectory()) throw new Error(`template not found: ${appTpl}`);
  if (!statSync(serverTpl).isDirectory()) throw new Error(`template not found: ${serverTpl}`);
  try { statSync(projectDir); throw new Error(`destination already exists: ${projectDir}`); } catch (e) { if (e.code !== 'ENOENT') throw e; }

  cpSync(appTpl, join(projectDir, 'app'), { recursive: true, filter: shouldCopy });
  cpSync(serverTpl, join(projectDir, 'server'), { recursive: true, filter: shouldCopy });

  const replacements = [[PLACEHOLDER_PKG, newPkg], [PLACEHOLDER_PROJ, `poc-${appName}`], ['targetapp', appName]];
  const changed = walkAndReplace(projectDir, replacements);

  return { appName, projectDir, package: newPkg, changedFiles: changed };
}

export function main(argv = process.argv.slice(2)) {
  const appName = argv[0];
  if (!appName) { usage(); return 1; }

  try {
    const r = createPocProject({ appName });
    console.log(`Created poc-${appName}/ (package ${r.package}) — ${r.changedFiles} file(s) updated`);
    console.log(`  Next: cd poc-${appName}/app && ./gradlew assembleDebug`);
    console.log(`  Next: cd poc-${appName}/server && node server.mjs`);
    return 0;
  } catch (e) {
    console.error(`Error: ${e.message}`);
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
