import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const packageRoot = fileURLToPath(new URL('../', import.meta.url));
export const repoRoot = path.resolve(packageRoot, '..');
export const distRoot = path.join(packageRoot, 'dist');
export const artifactRoot = path.join(packageRoot, 'artifacts');
export const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
export const packageInfo = () => readJson(path.join(packageRoot, 'package.json'));

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status}):\n${result.error?.message ?? ''}\n${result.stdout ?? ''}${result.stderr ?? ''}`);
  }
  return result.stdout;
}

/** npm sets this path for lifecycle scripts; using Node avoids npm.cmd/shell quoting. */
export function npm(args, options = {}) {
  const cli = process.env.npm_execpath;
  if (!cli || !fs.existsSync(cli)) {
    throw new Error('Run this script through npm run (npm_execpath is required).');
  }
  return run(process.execPath, [cli, ...args], options);
}
