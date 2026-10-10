/** Node preflight and release-script layout; downloads and verification stay in install. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isSafeRelativePath, type ToolManifest } from '../catalog/manifest.ts';
import { InstallError } from '../core/errors.ts';
import { applyExecutableMode, findFile } from '../core/fs.ts';
import { launcherText, type LaunchEntry } from './launch.ts';
import { runCommand, type BridgeContext } from './process.ts';

export function javascriptEntry(script: string, args: string[] = []): LaunchEntry {
  return { command: 'node', args: [script, ...args] };
}

export async function requireNode(ctx: Pick<BridgeContext, 'env'>): Promise<void> {
  const node = await runCommand(ctx, 'node', ['--version']);
  if (node.error !== undefined || node.status !== 0) {
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
  for (const name of manifest.launch.commands) {
    const found = findFile(app, [`${name}.mjs`, `${name}.cjs`, `${name}.js`]);
    if (found === null) {
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
