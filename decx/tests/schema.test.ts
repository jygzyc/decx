import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadManifests } from '../src/manifest.ts';
import { SUBPROJECTS_DIR } from './fixtures.ts';

test('one structural schema covers every tool without runtime-specific branches', () => {
  const file = fileURLToPath(new URL('../../subprojects/decx-tool.schema.json', import.meta.url));
  const schema = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.deepEqual(schema.required, ['manifest', 'summary', 'install', 'launch']);
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.oneOf, undefined);
  assert.equal(schema.allOf, undefined);

  const properties = schema.properties as Record<string, Record<string, unknown>>;
  assert.equal(properties.bins, undefined);
  assert.equal(properties.install!.type, 'array');
  assert.deepEqual(properties.launch!.required, ['type', 'commands']);

  const { tools, issues } = loadManifests(SUBPROJECTS_DIR);
  assert.deepEqual(issues, []);
  for (const tool of tools) {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(SUBPROJECTS_DIR, `decx-${tool.id}`, `decx-${tool.id}.json`), 'utf8'),
    ) as Record<string, unknown>;
    assert.equal(manifest.$schema, '../decx-tool.schema.json');
    for (const key of Object.keys(manifest)) {
      assert.ok(Object.hasOwn(properties, key), `${tool.id}.${key} is not in the schema`);
    }
    assert.equal(manifest.bins, undefined);
    const launch = manifest.launch as { type: string; commands: string[] };
    assert.deepEqual(launch, tool.launch);
    if (launch.type === 'bin') {
      assert.deepEqual(manifest.install, ['github-release']);
      assert.deepEqual(tool.install, ['github-release']);
    } else {
      assert.equal(launch.type, 'python');
      assert.deepEqual((manifest.install as string[]).slice(0, 2), ['pip', 'install']);
      assert.deepEqual(tool.install, manifest.install);
    }
  }
});
