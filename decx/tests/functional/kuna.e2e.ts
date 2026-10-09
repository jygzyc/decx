import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { analyze, compile, execute, fixtures } from './helpers.ts';

interface FunctionRecord { name: string; address: number; size: number; code: string; error: string | null }
interface FunctionsResult { error: string | null; functions: FunctionRecord[] }

test('real executable: run, discover, decompile, recompile and compare behavior through DECX', { timeout: 180_000 }, async (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'decx-real-binary-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const extension = process.platform === 'win32' ? '.exe' : '';
  const binary = path.join(temporary, `真实 native probe${extension}`);
  compile(path.join(fixtures, 'native-probe.c'), binary);
  const baseline = execute(binary, ['37'], temporary);
  assert.equal(baseline.status, 0, baseline.stderr);
  assert.equal(baseline.stdout.trim(), 'DECX_REAL_NATIVE score=1337 mix=272');
  const listed = JSON.parse(analyze('kuna', ['functions', binary, '--json'], temporary)) as FunctionsResult;
  assert.equal(listed.error, null);
  const targets = ['decx_score', 'decx_mix'].map(name => {
    const matches = listed.functions.filter(fn => fn.name.replace(/^_/, '') === name);
    assert.ok(matches.length, `Actual executable symbol missing: ${name}`);
    // PE debug builds can expose both the body and an incremental-link thunk.
    // Select the full body and use its address, never an ambiguous name selector.
    return matches.reduce((body, candidate) => candidate.size > body.size ? candidate : body);
  });
  const recovered: FunctionRecord[] = [];

  await t.test('recover nonempty C bodies from actual machine instructions', () => {
    for (const target of targets) {
      const result = JSON.parse(analyze('kuna', ['decompile', binary, `0x${target.address.toString(16)}`, '--addr', '--json'], temporary)) as FunctionsResult;
      assert.equal(result.error, null);
      assert.equal(result.functions.length, 1);
      const fn = result.functions[0];
      assert.ok(fn);
      assert.equal(fn.error, null, `${target.name}: decompiler failure`);
      assert.match(fn.code, /return\b/);
      assert.ok(fn.code.includes(fn.name));
      recovered.push(fn);
    }
    assert.ok(recovered[0]);
    assert.match(recovered[0].code, /\b(?:1337|0x539)\b/);
  });

  assert.equal(recovered.length, targets.length, 'Both actual functions must decompile before behavior comparison');
  const names = recovered.map(fn => fn.name);

  await t.test('recompile recovered C and match the original executable on branch and negative inputs', () => {
    const source = path.join(temporary, 'recovered.c');
    const rebuilt = path.join(temporary, `recovered${extension}`);
    fs.writeFileSync(source, `
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <stdbool.h>
typedef unsigned char undefined1;
typedef unsigned short undefined2;
typedef unsigned int undefined4;
typedef unsigned long long undefined8;
${recovered.map(fn => fn.code).join('\n')}
int main(int argc, char **argv) {
  int input = argc > 1 ? atoi(argv[1]) : 37;
  printf("DECX_REAL_NATIVE score=%d mix=%d\\n", (int32_t)${names[0]}(input), (int32_t)${names[1]}(input));
  return 0;
}
`);
    compile(source, rebuilt);
    for (const input of [-20, 0, 1, 36, 37, 38, 100]) {
      const original = execute(binary, [String(input)], temporary);
      const output = execute(rebuilt, [String(input)], temporary);
      assert.equal(original.status, 0, original.stderr);
      assert.equal(output.status, 0, output.stderr);
      assert.equal(output.stdout, original.stdout, `Recovered behavior differs at input=${input}`);
    }
  });

  await t.test('export an actual decompilation project and verify indexed C bodies', () => {
    const project = path.join(temporary, 'project export');
    analyze('kuna', ['decompile-project', binary, ...targets.flatMap(fn => ['--addr', `0x${fn.address.toString(16)}`]), '--jobs', '1', '--stream', '-o', project], temporary);
    const index = fs.readFileSync(path.join(project, 'index.jsonl'), 'utf8').trim().split(/\r?\n/)
      .map(line => JSON.parse(line) as { name: string; error: string | null; c_offset: number; c_len: number });
    const cFile = fs.readdirSync(project).find(name => name.endsWith('.c'));
    assert.ok(cFile, 'Project must contain generated C');
    const bytes = fs.readFileSync(path.join(project, cFile));
    for (const name of names) {
      const record = index.find(fn => fn.name === name);
      assert.ok(record, `Project index missing ${name}`);
      assert.equal(record.error, null);
      assert.ok(record.c_len > 0);
      assert.ok(bytes.subarray(record.c_offset, record.c_offset + record.c_len).toString('utf8').includes(name));
    }
    assert.ok(!fs.existsSync(path.join(project, '.streaming')), 'Project did not finalize');
  });
});
