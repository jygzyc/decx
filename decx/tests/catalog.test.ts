import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { validateManifest, loadManifests } from '../src/catalog/manifest.ts';
import { launcherEnv } from '../src/install/index.ts';

const catalogRoot = path.resolve(import.meta.dirname, '../../third_party');
const schema = JSON.parse(fs.readFileSync(path.join(catalogRoot, 'decx-tool.schema.json'), 'utf8'));
// Conditional subschemas constrain fields typed by the parent tool definition.
const validateSchema = new Ajv2020({ strict: false, allErrors: true }).compile(schema);
const bin = {
  id: 'fixture', repo: 'acme/fixture', summary: 'catalog fixture', env: {}, requires: 'bin',
  install: ['github-release'], launch: { type: 'bin', commands: ['fixture'] },
  release: { asset: 'fixture-{version}.zip' },
};
const js = { ...bin, requires: 'js', launch: { type: 'js', commands: ['fixture'] } };
const python = {
  id: 'fixture', repo: 'acme/fixture', summary: 'catalog fixture', env: {}, requires: 'python',
  install: ['pip', 'install', 'fixture'], launch: { type: 'python', commands: ['fixture'] },
};

function check(entry: unknown, expected: boolean): void {
  const parsed = validateManifest(entry);
  const schemaValid = validateSchema({ manifest: 1, tools: [entry] });
  assert.equal(parsed.manifest !== undefined, expected, JSON.stringify({ entry, errors: parsed.errors }));
  assert.equal(schemaValid, expected, JSON.stringify({ entry, errors: validateSchema.errors }));
}

test('schema and runtime accept the real catalog and every lifecycle fixture', () => {
  for (const root of [catalogRoot, ...['bin-tool', 'js-tool', 'python-tool'].map(id =>
    path.join(import.meta.dirname, 'fixtures', id))]) {
    const catalog = JSON.parse(fs.readFileSync(path.join(root, 'tools.json'), 'utf8'));
    assert.equal(validateSchema(catalog), true, JSON.stringify(validateSchema.errors));
    const loaded = loadManifests(root);
    assert.deepEqual(loaded.issues, []);
    assert.equal(loaded.tools.length, catalog.tools.length);
    for (const entry of catalog.tools) check(entry, true);
  }
});

test('schema and runtime share explicit runtime, environment and recipe constraints', () => {
  for (const entry of [bin, js, python]) {
    check(entry, true);
    for (const key of ['id', 'repo', 'summary', 'env', 'requires', 'install', 'launch']) {
      const missing: Record<string, unknown> = { ...entry };
      delete missing[key];
      check(missing, false);
    }
    for (const env of [null, [], '', { EMPTY: '' }, { EMPTY: ' \t' }, { 'invalid-name': 'value' }, { '': 'value' }, { 'NAME\n': 'value' }]) {
      check({ ...entry, env }, false);
    }
    for (const requires of [null, '', 'rust', {}, entry.requires === 'bin' ? 'python' : 'bin']) {
      check({ ...entry, requires }, false);
    }
    for (const install of [null, [], ['github-release', 'extra'], ['pip'], ['pip', 'install'], ['pip', 'install', '-r']]) {
      check({ ...entry, install }, false);
    }
    for (const commands of [[], ['..'], ['a/b'], ['a b'], ['fixture\n'], ['fixture', 'fixture']]) {
      check({ ...entry, launch: { type: entry.requires, commands } }, false);
    }
    check({ ...entry, summary: ' \t' }, false);
    check({ ...entry, verify: ' \t' }, false);
    check({ ...entry, unexpected: true }, false);
  }
  check({ ...bin, env: { DATA: '{prefix}/data', _MARKER: '{version}' } }, true);
  check({ ...js, env: { DATA: '{prefix}/data' } }, false);
  check({ ...python, env: { DATA: '{prefix}/data' } }, false);
  check({ ...python, install: ['pip', 'install', 'fixture', '--no-deps'] }, true);
  check({ ...python, release: bin.release }, false);
  check({ ...python, launch: { type: 'python', commands: ['fixture', 'other'] } }, false);
});

test('schema and runtime agree on release assets and empty env does not generate wrappers', () => {
  for (const release of [undefined, null, {}, { asset: '' }, { asset: ' \t' },
    { asset: 'one.zip', assets: { any: 'two.zip' } }, { assets: {} },
    { assets: { 'unknown-platform': 'one.zip' } }, { assets: { any: '' } },
    { asset: 'one.zip', extraAssets: { data: '' } }, { asset: 'one.zip', checksums: '' },
    { asset: 'one.zip', version: '' }, { asset: 'one.zip', tagPrefix: '' },
    { asset: 'one.zip', repository: 'other/repo' }]) {
    check({ ...bin, release }, false);
  }
  check({ ...bin, release: { assets: { any: 'one.zip' }, extraAssets: { specs: 'specs.zip' }, checksums: null } }, true);
  const manifest = validateManifest(bin).manifest!;
  assert.deepEqual(manifest.env, {});
  assert.equal(manifest.requires, 'bin');
  assert.equal(launcherEnv(manifest, '/payload', '1.0.0'), undefined);
  const special = { ...bin, env: JSON.parse('{"__proto__":"literal","DATA":"{prefix}/data"}') };
  check(special, true);
  const variables = launcherEnv(validateManifest(special).manifest!, '/payload', '1.0.0')!;
  assert.equal(Object.hasOwn(variables, '__proto__'), true);
  assert.equal(variables.__proto__, 'literal');
  assert.equal(variables.DATA, path.normalize('/payload/data'));
});
