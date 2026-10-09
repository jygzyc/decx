import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../../', import.meta.url));
export const fixtures = path.join(root, 'tests/fixtures/real-analysis');
const home = process.env.DECX_HOME ?? '';
assert.ok(home, 'Set DECX_HOME to an isolated prefix containing actual installed analyzers. Functional tests do not install or mock tools.');
assert.notEqual(path.resolve(home), os.homedir(), 'Do not use the real home directory as a test install prefix');
const nativeManager = process.env.DECX_FUNCTIONAL_MANAGER;
const manager = nativeManager ? path.resolve(nativeManager) : process.execPath;
const bundle = path.join(root, 'dist/decx.mjs');
const prefix = nativeManager ? [] : [bundle];
assert.ok(fs.existsSync(nativeManager ? manager : bundle), 'Build the manager before running functional tests');

export function execute(command: string, args: string[], cwd: string) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 120_000, maxBuffer: 32 * 1024 * 1024 });
  assert.ifError(result.error);
  return result;
}

export function analyze(tool: string, args: string[], cwd: string) {
  const result = analyzeFailure(tool, args, cwd);
  assert.equal(result.status, 0, `${tool} ${args.join(' ')}\n${result.stderr}\n${result.stdout}`);
  return result.stdout;
}

export function analyzeFailure(tool: string, args: string[], cwd: string) {
  return execute(manager, [...prefix, '--home', home, '-m', tool, ...args], cwd);
}

export function compile(source: string, output: string): void {
  const compiler = process.env.CC ?? (process.platform === 'win32' ? 'cl' : 'cc');
  const args = process.platform === 'win32'
    ? ['/nologo', '/Od', '/Zi', source, `/Fe:${output}`]
    : ['-O0', '-g', '-fno-inline', source, '-o', output];
  const result = execute(compiler, args, path.dirname(output));
  assert.equal(result.status, 0, `Compile real fixture: ${compiler}\n${result.stderr}\n${result.stdout}`);
  const magic = fs.readFileSync(output).subarray(0, 4).toString('hex');
  if (process.platform === 'win32') assert.ok(magic.startsWith('4d5a'), 'Expected a real PE executable');
  else if (process.platform === 'linux') assert.equal(magic, '7f454c46', 'Expected a real ELF executable');
  else assert.equal(magic, 'cffaedfe', 'Expected a real 64-bit Mach-O executable');
}
