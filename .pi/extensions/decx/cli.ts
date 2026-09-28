#!/usr/bin/env node
/**
 * Decx CLI — run the knowledge-base logic without an agent.
 *
 *   node .pi/extensions/decx/cli.ts init
 *   node .pi/extensions/decx/cli.ts workspaces
 *   node .pi/extensions/decx/cli.ts status [<workspace>] [--workspace <name>]
 *   node .pi/extensions/decx/cli.ts check  [<workspace>] [--workspace <name>] [--json]
 *   node .pi/extensions/decx/cli.ts resync [<workspace>] [--workspace <name>]
 *
 * `--root <dir>` selects the project (default: the current directory).
 * `check` exits 1 when a workspace has errors, so CI can gate on it.
 */

import { join, resolve } from 'node:path';
import {
  describeFinding,
  describeStatus,
  discoverWorkspaces,
  ensureWorkspace,
  initLocalWiki,
  isWikiError,
  requireWorkspace,
  resyncIndex,
  status,
} from './lib.ts';
import { nodeFs, withWorkspaceLock } from './node-fs.ts';

interface Options {
  command: string;
  root: string;
  workspace?: string;
  json: boolean;
}

function parse(argv: string[]): Options {
  const [command = 'status', ...rest] = argv;
  const options: Options = { command, root: process.cwd(), json: false };
  if (['help', '--help', '-h'].includes(command)) {
    options.command = 'help';
    return options;
  }

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

async function init(root: string, fs: ReturnType<typeof nodeFs>): Promise<void> {
  const target = join(root, '.decxwiki');
  // Reject a symlink before creating the lock directory.
  await fs.exists(target);
  const result = await withWorkspaceLock(target, () => initLocalWiki(root, fs));
  console.log(
    `${result.workspace.root}: initialized (${result.created.length} new wiki files; ` +
      `skill layer at ${result.workspace.skills}; install skills separately with npx skills)`,
  );
}

const HELP = [
  'Usage: node .pi/extensions/decx/cli.ts <command> [options]',
  '',
  'Commands:',
  '  init         initialize <root>/.decxwiki and the empty <root>/.agents/skills layer',
  '  workspaces   list the initialized workspace',
  '  status       show workspace status (default)',
  '  check        lint the workspace; exits 1 when errors exist',
  '  resync       rebuild wiki/index.md from pattern pages',
  '',
  'Options:',
  '  --root <dir>       project directory (default: current directory)',
  '  --workspace <name> select a workspace by name',
  '  --json             machine-readable check output',
].join('\n');

async function main(): Promise<number> {
  const options = parse(process.argv.slice(2));
  if (options.command === 'help') {
    console.log(HELP);
    return 0;
  }

  const fs = nodeFs();
  // The CLI and extension both discover only this project's initialized wiki.
  const root = resolve(options.root);
  if (options.command === 'init') {
    if (options.workspace !== undefined) {
      throw new Error('init always targets <root>/.decxwiki; omit --workspace');
    }
    await init(root, fs);
    return 0;
  }
  const all = await discoverWorkspaces(root, fs);
  if (options.command === 'workspaces') {
    for (const workspace of all) {
      console.log(
        `${workspace.name}\t${workspace.root}\twiki=${workspace.wiki}\traw=${workspace.raw}\tskills=${workspace.skills}`,
      );
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
      const result = await withWorkspaceLock(workspace.root, async () => {
        await ensureWorkspace(workspace, fs);
        return resyncIndex(workspace, fs);
      });
      console.log(
        `${workspace.name}: ${result.total} patterns ` +
          `(added ${result.added.length}, removed ${result.removed.length})`,
      );
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
  console.error(`unknown command: ${options.command}\n\n${HELP}`);
  return 2;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    const message = isWikiError(error)
      ? `${error.code}: ${error.message}${error.hint === undefined ? '' : `\nhint: ${error.hint}`}`
      : String(error instanceof Error ? error.message : error);
    console.error(message);
    process.exit(2);
  });
