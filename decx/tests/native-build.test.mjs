import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const script = fs.readFileSync(new URL('../scripts/build-scriptc.mjs', import.meta.url), 'utf8');

test('native compilation preserves typed sources rather than compiling an erased JS bundle', () => {
  assert.match(script, /fs\.cpSync\(path\.join\(root, 'src'\)/);
  assert.doesNotMatch(script, /dist', 'decx\.mjs|__DECX_BUNDLE__/);
  assert.equal(fs.existsSync(new URL('../scripts/native-launcher.ts', import.meta.url)), false);
});

test('native smoke runs outside the checkout with no interpreter on PATH', () => {
  assert.match(script, /cwd: smokeHome/);
  assert.match(script, /PATH: smokeHome, Path: smokeHome/);
  assert.match(script, /version\.version, packageInfo\.version/);
});
