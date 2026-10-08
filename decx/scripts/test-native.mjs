#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const result = spawnSync(process.execPath, ['--test', 'tests/native-runtime.test.ts'], {
  cwd: fileURLToPath(new URL('../', import.meta.url)),
  env: { ...process.env, DECX_NATIVE_TEST: '1' }, stdio: 'inherit',
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
