/** Node preflight and release-script layout; downloads and verification stay in install. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isSafeRelativePath, type ToolManifest } from '../catalog/manifest.ts';
import { InstallError } from '../core/errors.ts';
import { applyExecutableMode, indexFiles } from '../core/fs.ts';
import { launcherText, type LaunchEntry } from './launch.ts';
import type { ResolvedInstallContext } from '../install/types.ts';
import { runCommand } from './process.ts';

export function javascriptEntry(script: string, args: string[] = []): LaunchEntry {
  return { command: 'node', args: [script, ...args] };
}

export async function requireNode(ctx: Pick<ResolvedInstallContext, 'env'>): Promise<void> {
  const node = await runCommand('node', ['--version'], ctx);
  if (node.failed) {
    throw new InstallError('NODE_NOT_FOUND', 'JS tools require Node on PATH; install Node before running decx install');
  }
}

export function stageJavascriptRelease(
  manifest: ToolManifest,
  extract: string,
  stage: string,
  asset: string,
  windows: boolean,
  prefix: string,
): { binaries: string[]; verifyScript: string } {
  const binaries: string[] = [];
  let verifyScript = '';
  const app = path.join(stage, 'share', manifest.id, 'app');
  fs.mkdirSync(path.dirname(app), { recursive: true });
  fs.renameSync(extract, app);
  fs.mkdirSync(path.join(stage, 'bin'), { recursive: true });
  const files = indexFiles(app);
  for (const name of manifest.launch.commands) {
    const found = files.get(`${name}.mjs`) ?? files.get(`${name}.cjs`) ?? files.get(`${name}.js`);
    if (found === undefined) {
      throw new InstallError('ASSET_LAYOUT', `'${asset}' does not contain a Node script for '${name}' (.mjs, .cjs or .js)`);
    }
    const script = path.relative(app, found).split(path.sep).join('/');
    if (!isSafeRelativePath(script)) {
      throw new InstallError('ASSET_LAYOUT', `'${asset}' has an unsafe Node script path: ${script}`);
    }
    const launcher = windows ? `${name}.cmd` : name;
    fs.writeFileSync(
      path.join(stage, 'bin', launcher),
      launcherText(javascriptEntry(path.join(prefix, 'app', script)), windows),
    );
    if (!windows) applyExecutableMode(path.join(stage, 'bin', launcher));
    binaries.push(launcher);
    if (verifyScript === '') verifyScript = path.join(app, script);
  }
  return { binaries, verifyScript };
}
