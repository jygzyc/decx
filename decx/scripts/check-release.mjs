#!/usr/bin/env node
/**
 * Validate a CLI release tag: it must be exactly `decx-v<version>` where
 * <version> is decx/package.json's `version`. The tag is passed as argv[2]
 * or read from GITHUB_REF_NAME.
 */
import { packageInfo } from './common.mjs';

const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME ?? '';
const { version } = packageInfo();
const expected = `decx-v${version}`;
if (tag !== expected) {
  console.error(`release tag '${tag}' does not match decx/package.json (expected ${expected})`);
  process.exit(1);
}
console.log(`release tag ${tag} matches decx/package.json version ${version}`);
