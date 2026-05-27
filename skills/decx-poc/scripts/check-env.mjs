#!/usr/bin/env node

/**
 * PoC build environment check.
 *
 * Usage: node check-env.mjs
 *
 * Checks Android SDK and JDK availability.
 * Does not mutate the environment.
 */

import { execSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const checks = [];
let hasError = false;

function check(name, fn) {
  try {
    const result = fn();
    checks.push({ name, status: 'ok', detail: result });
  } catch (error) {
    hasError = true;
    checks.push({ name, status: 'fail', detail: error.message });
  }
}

function checkOptional(name, fn) {
  try {
    const result = fn();
    checks.push({ name, status: 'ok', detail: result, optional: true });
  } catch (error) {
    checks.push({ name, status: 'warn', detail: error.message, optional: true });
  }
}

function getSdkHome() {
  const home = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (!home) {
    throw new Error('ANDROID_HOME or ANDROID_SDK_ROOT is not set');
  }
  if (!existsSync(home)) {
    throw new Error(`directory does not exist: ${home}`);
  }
  return home;
}

check('Android SDK home', () => getSdkHome());

check('SDK build-tools', () => {
  const dir = join(getSdkHome(), 'build-tools');
  if (!existsSync(dir)) {
    throw new Error(`directory does not exist: ${dir}`);
  }
  const versions = readdirSync(dir);
  if (versions.length === 0) {
    throw new Error('directory is empty');
  }
  return versions.join(', ');
});

check('SDK platforms', () => {
  const dir = join(getSdkHome(), 'platforms');
  if (!existsSync(dir)) {
    throw new Error(`directory does not exist: ${dir}`);
  }
  const versions = readdirSync(dir);
  if (versions.length === 0) {
    throw new Error('directory is empty');
  }
  return versions.join(', ');
});

check('JDK (java)', () => {
  const output = execSync('java -version 2>&1', { encoding: 'utf-8' });
  const match = output.match(/version "(\d+)/);
  if (!match) {
    throw new Error('unable to parse java version');
  }
  const major = Number.parseInt(match[1], 10);
  if (major < 11) {
    throw new Error(`JDK ${major} is below the minimum required version 11`);
  }
  return match[0];
});

check('JDK (javac)', () => {
  const output = execSync('javac -version 2>&1', { encoding: 'utf-8' });
  const match = output.match(/javac (\d+)/);
  if (!match) {
    throw new Error('unable to parse javac version');
  }
  const major = Number.parseInt(match[1], 10);
  if (major < 11) {
    throw new Error(`javac ${major} is below the minimum required version 11`);
  }
  return match[0];
});

checkOptional('adb (optional)', () => {
  const output = execSync('adb version 2>&1', { encoding: 'utf-8' });
  return output.split('\n')[0];
});

console.log('');
console.log('PoC Build Environment Check');
console.log('-'.repeat(50));

for (const item of checks) {
  const icon = item.status === 'ok' ? 'OK' : item.status === 'warn' ? 'WARN' : 'FAIL';
  console.log(`  [${icon}] ${item.name}`);
  if (item.detail) {
    console.log(`    ${item.detail}`);
  }
}

console.log('-'.repeat(50));

if (hasError) {
  console.log('Environment check failed. Build should not proceed.');
  process.exit(1);
}

console.log('Environment check passed. Build can proceed.');
process.exit(0);
