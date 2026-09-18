#!/usr/bin/env node
/**
 * Decx CLI — run the knowledge-base logic without an agent.
 *
 *   node .pi/extensions/decx/cli.ts workspaces
 *   node .pi/extensions/decx/cli.ts status [<workspace>] [--workspace <name>]
 *   node .pi/extensions/decx/cli.ts check  [<workspace>] [--workspace <name>] [--json]
 *   node .pi/extensions/decx/cli.ts resync [<workspace>] [--workspace <name>]
 *
 * `--root <dir>` selects the project (default: the current directory).
 * `check` exits 1 when a workspace has errors, so CI can gate on it.
 */

import { join, resolve } from 'node:path';
import { discoverWorkspaces, describeFinding, describeStatus, ensureWorkspace, isWikiError, readWorkspaceConfig, requireWorkspace, resyncIndex, status } from './lib.ts';
import { nodeFs } from './node-fs.ts';

interface Options {
  command: string;
  root: string;
  workspace?: string;
  json: boolean;
}

function parse(argv: string[]): Options {
  const [command = 'status', ...rest] = argv;
  const options: Options = { command, root: process.cwd(), json: false };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === '--root') {
      index += 1;
      options.root = rest[index] ?? options.root;
    } else if (arg === '--workspace') {
      index += 1;
      options.workspace = rest[index];
    } else if (arg === '--json') {
      options.json = true;
    } else if (!arg.startsWith('-')) {
      options.workspace = arg;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

async function main(): Promise<number> {
  const options = parse(process.argv.slice(2));
  const fs = nodeFs();
  // The workspace name and roots come from the same config file the pi extension reads
  // (pi's CONFIG_DIR_NAME defaults to .pi), so the CLI and the agent agree on the project.
  const root = resolve(options.root);
  const configured = await readWorkspaceConfig(join(root, '.pi', 'extensions', 'decx.json'), fs);
  const all = await discoverWorkspaces(root, fs, configured);
  if (options.command === 'workspaces') {
    for (const workspace of all) {
      console.log(`${workspace.name}\t${workspace.root}\twiki=${workspace.wiki}\traw=${workspace.raw}\tskills=${workspace.skills}`);
    }
    return 0;
  }
  const targets = options.workspace === undefined ? all : [requireWorkspace(all, options.workspace)];
  if (targets.length === 0) {
    console.error(`no decx workspace under ${root}`);
    return 1;
  }

  if (options.command === 'resync') {
    for (const workspace of targets) {
      await ensureWorkspace(workspace, fs);
      const result = await resyncIndex(workspace, fs);
      console.log(`${workspace.name}: ${result.total} patterns (added ${result.added.length}, removed ${result.removed.length})`);
    }
    return 0;
  }

  const states = await Promise.all(targets.map((workspace) => status(workspace, fs)));
  if (options.command === 'status') {
    for (const state of states) {
      console.log(describeStatus(state));
      if (state.lastLog !== undefined) {
        console.log(`  last: ${state.lastLog}`);
      }
    }
    return 0;
  }
  if (options.command === 'check') {
    const findings = states.flatMap((state) => state.findings);
    if (options.json) {
      console.log(JSON.stringify({ states, findings }, null, 2));
    } else {
      for (const state of states) {
        console.log(describeStatus(state));
      }
      for (const finding of findings) {
        console.log(describeFinding(finding));
      }
    }
    return findings.some((finding) => finding.level === 'error') ? 1 : 0;
  }
  console.error(`unknown command: ${options.command}\ncommands: workspaces, status, check, resync`);
  return 2;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(isWikiError(error) ? `${error.code}: ${error.message}${error.hint === undefined ? '' : `\nhint: ${error.hint}`}` : String(error instanceof Error ? error.message : error));
    process.exit(2);
  });
