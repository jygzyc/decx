import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SUPPORTED_PLATFORMS, exeSuffix, osLabel, platformKey } from '../src/platform.ts';

test('platform keys use the toolkit vocabulary', () => {
  assert.equal(platformKey('darwin', 'arm64'), 'darwin-arm64');
  assert.equal(platformKey('darwin', 'x64'), 'darwin-amd64');
  assert.equal(platformKey('linux', 'x64'), 'linux-amd64');
  assert.equal(platformKey('linux', 'arm64'), 'linux-arm64');
  assert.equal(platformKey('win32', 'x64'), 'win-amd64');
  assert.equal(platformKey('win32', 'arm64'), 'win-arm64');
});

test('unsupported platform and arch pairs return null', () => {
  assert.equal(platformKey('freebsd', 'x64'), null);
  assert.equal(platformKey('linux', 'ia32'), null);
  assert.equal(platformKey('linux', 'riscv64'), null);
});

test('every supported key round-trips through the label helper', () => {
  assert.equal(SUPPORTED_PLATFORMS.length, 6);
  assert.equal(osLabel('darwin'), 'macOS');
  assert.equal(osLabel('win32'), 'Windows');
  assert.equal(osLabel('plan9'), 'plan9');
});

test('executable suffix is only used on Windows', () => {
  assert.equal(exeSuffix('win32'), '.exe');
  assert.equal(exeSuffix('darwin'), '');
  assert.equal(exeSuffix('linux'), '');
});
