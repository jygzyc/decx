#!/usr/bin/env node

/**
 * PoC build environment check.
 *
 * Usage: node check-env.mjs
 *
 * Checks Android SDK and JDK availability. Does not mutate the environment.
 */

import { execSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

let failed = false;

function check(name, fn, optional = false) {
  try {
    const detail = fn();
    console.log(`  [OK] ${name}`);
    if (detail) console.log(`       ${detail}`);
  } catch (e) {
    failed = !optional;
    const tag = optional ? 'WARN' : 'FAIL';
    console.log(`  [${tag}] ${name}: ${e.message}`);
  }
}

function sdkHome() {
  const home = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (home) {
    if (!existsSync(home)) throw new Error(`directory does not exist: ${home}`);
    return home;
  }
  // Fallback: SDK not exported, but sdkmanager on PATH means an SDK is manageable.
  execSync('sdkmanager --version 2>&1', { encoding: 'utf-8' });
  throw new Error('ANDROID_HOME or ANDROID_SDK_ROOT is not set (sdkmanager is available; set it to the SDK root)');
}

check('Android SDK home', () => sdkHome());
check('SDK build-tools', () => {
  const v = readdirSync(join(sdkHome(), 'build-tools'));
  if (!v.length) throw new Error('empty');
  return v.join(', ');
});
check('SDK platforms', () => {
  const v = readdirSync(join(sdkHome(), 'platforms'));
  if (!v.length) throw new Error('empty');
  return v.join(', ');
});
check('JDK (java)', () => {
  const m = execSync('java -version 2>&1', { encoding: 'utf-8' }).match(/version "(\d+)/);
  if (!m || +m[1] < 11) throw new Error('requires JDK >= 11');
  if (+m[1] > 17) {
    console.log('  [WARN] newer JDK detected: pick a Gradle/AGP pair that supports this JDK (see poc-base.md version selection rule)');
  }
  return m[0];
});
check('JDK (javac)', () => {
  const m = execSync('javac -version 2>&1', { encoding: 'utf-8' }).match(/javac (\d+)/);
  if (!m || +m[1] < 11) throw new Error('requires JDK >= 11');
  return m[0];
});
check('adb', () => execSync('adb version 2>&1', { encoding: 'utf-8' }).split('\n')[0], true);

console.log(failed ? '\nEnvironment check failed.' : '\nEnvironment check passed.');
process.exit(failed ? 1 : 0);
