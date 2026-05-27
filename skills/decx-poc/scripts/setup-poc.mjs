#!/usr/bin/env node

/**
 * PoC project bootstrap script.
 *
 * Usage: node setup-poc.mjs <target-app>
 *
 * Copies the split PoC template and replaces placeholders:
 *   com.poc.targetapp -> com.poc.<target-app>
 *   poc-targetapp -> poc-<target-app>
 */

import {
  cpSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, dirname, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PLACEHOLDER_PACKAGE = 'com.poc.targetapp';
const PLACEHOLDER_PROJECT = 'poc-targetapp';
const TEXT_EXTENSIONS = new Set([
  '.java',
  '.kt',
  '.xml',
  '.gradle',
  '.kts',
  '.properties',
  '.toml',
  '.md',
  '.txt',
  '.pro',
  '.html',
  '.js',
  '.css',
  '.mjs',
  '.json',
]);

function usage(stream = process.stderr) {
  stream.write('Usage: node setup-poc.mjs <target-app>\n');
  stream.write('\n');
  stream.write('Examples:\n');
  stream.write('  node setup-poc.mjs myapp   -> creates poc-myapp/, package com.poc.myapp\n');
  stream.write('  node setup-poc.mjs wechat  -> creates poc-wechat/, package com.poc.wechat\n');
}

export function isValidAppName(name) {
  return Boolean(name) && /^[a-z][a-z0-9]*$/.test(name);
}

function assertValidAppName(name) {
  if (isValidAppName(name)) {
    return;
  }
  throw new Error(
    `invalid app name "${name}". Use lowercase letters or digits, starting with a letter.`
  );
}

function copyDir(src, dest) {
  cpSync(src, dest, { recursive: true });
}

function isTextFile(filePath) {
  return TEXT_EXTENSIONS.has(extname(filePath));
}

function replaceInFile(filePath, replacements) {
  if (!isTextFile(filePath)) {
    return false;
  }

  let content = readFileSync(filePath, 'utf-8');
  let changed = false;

  for (const [from, to] of replacements) {
    if (content.includes(from)) {
      content = content.replaceAll(from, to);
      changed = true;
    }
  }

  if (changed) {
    writeFileSync(filePath, content, 'utf-8');
  }

  return changed;
}

function renamePathIfNeeded(filePath, replacements) {
  const currentName = basename(filePath);
  let nextName = currentName;

  for (const [from, to] of replacements) {
    if (nextName.includes(from)) {
      nextName = nextName.replaceAll(from, to);
    }
  }

  if (nextName === currentName) {
    return filePath;
  }

  const nextPath = join(dirname(filePath), nextName);
  renameSync(filePath, nextPath);
  return nextPath;
}

function walkAndReplace(baseDir, contentReplacements, pathReplacements) {
  const entries = readdirSync(baseDir, { withFileTypes: true });
  let changedFiles = 0;

  for (const entry of entries) {
    let fullPath = join(baseDir, entry.name);
    if (entry.isDirectory()) {
      changedFiles += walkAndReplace(fullPath, contentReplacements, pathReplacements);
      fullPath = renamePathIfNeeded(fullPath, pathReplacements);
    } else if (replaceInFile(fullPath, contentReplacements)) {
      changedFiles++;
      fullPath = renamePathIfNeeded(fullPath, pathReplacements);
    } else {
      fullPath = renamePathIfNeeded(fullPath, pathReplacements);
    }
  }

  return changedFiles;
}

function collectRemainingMatches(baseDir, terms) {
  const matches = [];
  const entries = readdirSync(baseDir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(baseDir, entry.name);
    if (entry.isDirectory()) {
      matches.push(...collectRemainingMatches(fullPath, terms));
      continue;
    }

    if (!isTextFile(fullPath)) {
      continue;
    }

    const content = readFileSync(fullPath, 'utf-8');
    if (terms.some((term) => content.includes(term))) {
      matches.push(fullPath);
    }
  }

  return matches;
}

function ensureDirectoryExists(dirPath) {
  try {
    if (!statSync(dirPath).isDirectory()) {
      throw new Error(`template not found: ${dirPath}`);
    }
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`template not found: ${dirPath}`);
    }
    throw error;
  }
}

function ensureDestinationMissing(projectDir) {
  try {
    statSync(projectDir);
    throw new Error(`destination already exists: ${projectDir}`);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return;
    }
    throw error;
  }
}

export function createPocProject({ appName, cwd = process.cwd() }) {
  assertValidAppName(appName);

  const targetPackageSegment = appName;
  const newPackage = `com.poc.${appName}`;
  const projectDir = join(cwd, `poc-${appName}`);
  const appTemplateDir = join(__dirname, '..', 'assets', 'poc-template-app');
  const serverTemplateDir = join(__dirname, '..', 'assets', 'poc-template-server');
  const contentReplacements = new Map([
    [PLACEHOLDER_PACKAGE, newPackage],
    [PLACEHOLDER_PROJECT, `poc-${appName}`],
  ]);
  const pathReplacements = new Map([['targetapp', targetPackageSegment]]);

  ensureDirectoryExists(appTemplateDir);
  ensureDirectoryExists(serverTemplateDir);
  ensureDestinationMissing(projectDir);

  copyDir(appTemplateDir, join(projectDir, 'app'));
  copyDir(serverTemplateDir, join(projectDir, 'server'));

  const changedFiles = walkAndReplace(projectDir, contentReplacements, pathReplacements);
  const remaining = collectRemainingMatches(projectDir, [
    PLACEHOLDER_PACKAGE,
    PLACEHOLDER_PROJECT,
  ]);

  return {
    appName,
    projectDir,
    newPackage,
    changedFiles,
    remaining,
  };
}

function printSummary(result) {
  console.log('Initializing PoC project...');
  console.log(`  Target app: ${result.appName}`);
  console.log(`  Package: ${PLACEHOLDER_PACKAGE} -> ${result.newPackage}`);
  console.log(`  Output dir: ${result.projectDir}`);
  console.log('');
  console.log('  [1/3] Copying split templates...');
  console.log('  [2/3] Replacing placeholders...');
  console.log('  [3/3] Verifying...');
  console.log('');
  console.log(`Created PoC project: ${result.projectDir}`);
  console.log(`Updated ${result.changedFiles} file(s)`);

  if (result.remaining.length > 0) {
    console.warn('');
    console.warn('Warning: unresolved placeholders remain in:');
    for (const file of result.remaining) {
      console.warn(`  - ${file}`);
    }
  }

  console.log('');
  console.log('Next steps:');
  console.log(`  cd ${join(result.projectDir, 'app')}`);
  console.log('  ./gradlew assembleDebug');
  console.log(`  cd ${join(result.projectDir, 'server')}`);
  console.log('  npm start');
}

export function main(argv = process.argv.slice(2)) {
  const appName = argv[0];
  if (!appName) {
    usage();
    return 1;
  }

  try {
    const result = createPocProject({ appName });
    printSummary(result);
    return 0;
  } catch (error) {
    console.error(`Error: ${error.message}`);
    if (String(error.message).includes('destination already exists')) {
      console.error('Remove it first if you want to recreate the project.');
    }
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
