import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPocProject, isValidAppName } from './setup-poc.mjs';

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), 'decx-poc-'));
}

test('isValidAppName accepts only lowercase alphanumeric names starting with a letter', () => {
  assert.equal(isValidAppName('wechat'), true);
  assert.equal(isValidAppName('app01'), true);
  assert.equal(isValidAppName(''), false);
  assert.equal(isValidAppName('1app'), false);
  assert.equal(isValidAppName('my-app'), false);
  assert.equal(isValidAppName('MyApp'), false);
});

test('createPocProject copies split templates and resolves placeholders', () => {
  const workdir = makeTempDir();

  try {
    const result = createPocProject({
      appName: 'wechat',
      cwd: workdir,
    });

    assert.equal(result.remaining.length, 0);

    const activity = readFileSync(
      join(
        result.projectDir,
        'app',
        'app',
        'src',
        'main',
        'java',
        'com',
        'poc',
        'wechat',
        'PoCActivity.java'
      ),
      'utf-8'
    );
    const manifest = readFileSync(
      join(result.projectDir, 'app', 'app', 'src', 'main', 'AndroidManifest.xml'),
      'utf-8'
    );
    const indexHtml = readFileSync(
      join(result.projectDir, 'server', 'public', 'index.html'),
      'utf-8'
    );

    assert.match(activity, /package com\.poc\.wechat;/);
    assert.match(manifest, /android:scheme="poc-wechat"/);
    assert.match(indexHtml, /Project: <code>poc-wechat<\/code>/);
    assert.doesNotMatch(activity, /targetapp/);
    assert.doesNotMatch(indexHtml, /poc-targetapp/);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test('createPocProject rejects an existing destination', () => {
  const workdir = makeTempDir();

  try {
    createPocProject({ appName: 'demo', cwd: workdir });

    assert.throws(
      () => createPocProject({ appName: 'demo', cwd: workdir }),
      /destination already exists/
    );
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});
