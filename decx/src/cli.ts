#!/usr/bin/env node
/**
 * `decx` -- install the DECX tools and run them.  It is a thin wrapper:
 * `install` moves files into DECX_HOME, `decx -m <tool> [args...]` execs the
 * installed launcher with every later argument untouched, and the tools
 * themselves are never translated.
 *
 * Data commands print one JSON object on stdout (`help` and a module run print
 * text or the tool's own output); failures use
 * `{ok:false,error:{code,message,hint}}` and exit 1 (runtime error) or 2
 * (usage error).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KNOWN_COMMANDS, parseArgs, type CliArgs } from './args.ts';
import { binRoot, resolveHome } from './config.ts';
import { defaultRunner, InstallError, installTool, type InstallOptions, type InstallResult } from './install.ts';
import { toolState } from './inspect.ts';
import { fail, ok, stringify } from './json.ts';
import { loadManifests, type LoadResult, type ToolManifest } from './manifest.ts';
import { currentPlatformKey } from './platform.ts';
import { launchSpec } from './launch.ts';
import { removeTool } from './remove.ts';

/** Replaced by the bundler; absent when Node runs the TypeScript source. */
declare const __DECX_VERSION__: string;
declare const __DECX_MANIFESTS__: LoadResult;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUBPROJECTS_DIR = path.resolve(HERE, '..', '..', 'subprojects');
const REPO_ROOT = path.resolve(HERE, '..', '..');

const HELP = `decx -- DECX toolkit installer and manager

usage: decx <command> [options]
       decx <tool> [args...]     run one installed tool
       decx -m <tool> [args...]  equivalent explicit form

commands:
  install <tool>       download or build a tool into DECX_HOME (JSON)
  update <tool>        install the latest release, replacing the installed version
  remove <tool>        remove an installed tool
  version              print the CLI version (JSON)
  help [command]       print help

run:
  <tool>             exec an installed launcher directly
  -m, --module <tool>  same as above; every argument after the
                       tool id is the tool's own, flags included

options:
  --home/--prefix <dir>  install root (default $DECX_HOME, else ~/.decx)
  --subprojects <dir>  tool subproject directory (overrides embedded/repository tools)
  --pretty             indent the JSON output
  -h, --help           print help (decx <command> --help for one command)
  -V, --version        print the CLI version

install options:
  --version <tag>      release tag to install (e.g. 1.508 or tools-v0.1.0)
  --force              reinstall over an existing install, replacing links
  --links <dir>        PATH link directory (default ~/.local/bin)
  --no-links           install without PATH links

exit codes: 0 success, 1 runtime error, 2 usage error
`;

const COMMAND_HELP: Record<string, string> = {
  update: `usage: decx update <tool> [--version <tag>] [--home <dir>] [--links <dir>]\n\nReplace an installed tool with the newest matching GitHub release.\n`,
  remove: `usage: decx remove <tool> [--home <dir>]\n\nRemove the installed tool, its private runtime, and managed PATH links.\n`,
  install: `usage: decx install <tool> [options]

Install one tool into DECX_HOME: the executables go to $DECX_HOME/bin, the
payload to $DECX_HOME/share/<tool>, and a PATH link to ~/.local/bin (or
--links).  Release installs download the platform asset and verify it against
the release's checksums when the manifest declares them; kind "python-venv"
tools install the declared package into a private virtualenv.  Nothing is
committed until every check, including the tool's own verify command, has
succeeded.

options: --version <tag>, --force, --links <dir>, --no-links, --home <dir>,
         --subprojects <dir>, --pretty
`,
};

export { parseArgs } from './args.ts';

function packageVersion(): string {
  if (typeof __DECX_VERSION__ !== 'undefined') return __DECX_VERSION__;
  try {
    const file = path.resolve(HERE, '..', 'package.json');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { version?: string };
    return parsed.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function emit(value: unknown, pretty: boolean): void {
  process.stdout.write(`${stringify(value, pretty)}\n`);
}

function emitFailure(command: string | null, code: string, message: string, hint: string | undefined, exitCode: number): number {
  process.stdout.write(`${stringify(fail(command, code, message, hint))}\n`);
  return exitCode;
}

function failAndExit(command: string | null, code: string, message: string, hint: string | undefined, exitCode: number): never {
  process.exit(emitFailure(command, code, message, hint, exitCode));
}

function failWith(command: string | null, error: unknown): number {
  if (error instanceof InstallError) {
    return emitFailure(command, error.code, error.message, error.hint, error.exitCode);
  }
  return emitFailure(command, 'INTERNAL_ERROR', (error as Error).message, undefined, 1);
}

function toolId(positionals: readonly string[], command: string): string {
  const id = positionals[0];
  if (id === undefined) {
    throw new InstallError('USAGE', `decx ${command} needs a tool id`, {
      hint: `run \`decx help ${command}\``,
      exitCode: 2,
    });
  }
  return id;
}

function requireManifest(load: LoadResult, id: string): ToolManifest {
  const manifest = load.tools.find((tool) => tool.id === id);
  if (manifest === undefined) {
    const known = load.tools.map((tool) => tool.id).join(', ');
    throw new InstallError('UNKNOWN_TOOL', `unknown tool: ${id}`, {
      hint: known === '' ? 'no tool manifests were found' : `known tools: ${known}`,
      exitCode: 2,
    });
  }
  return manifest;
}

function installOptions(args: CliArgs): InstallOptions {
  return {
    ...(args.releaseTag !== undefined ? { version: args.releaseTag } : {}),
    force: args.force,
    ...(args.links !== undefined ? { links: args.links } : {}),
    ...(args.noLinks ? { noLinks: true } : {}),
  };
}

/** JSON payload of `decx install`. */
export function installPayload(result: InstallResult): Record<string, unknown> {
  return {
    id: result.id,
    method: result.method,
    prefix: result.prefix,
    binDir: result.binDir,
    launcher: result.launcher,
    binaries: result.binaries,
    ...(result.version !== undefined ? { version: result.version } : {}),
    ...(result.releaseTag !== undefined ? { releaseTag: result.releaseTag } : {}),
    ...(result.asset !== undefined ? { asset: result.asset } : {}),
    ...(result.specsInstalled !== undefined ? { specsInstalled: result.specsInstalled } : {}),
    ...(result.checksum !== undefined ? { checksum: result.checksum } : {}),
    provenance: result.provenance,
    pathHint: result.pathHint,
  };
}

export { launchSpec } from './launch.ts';

export async function run(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const args = parseArgs(argv);
  const command = args.command;
  const moduleId = args.module;
  // A module run is not a manager command: the failure envelope says `module`.
  const origin = moduleId !== undefined ? 'module' : command;
  if (args.error !== undefined) {
    failAndExit(origin, 'USAGE', args.error, 'run `decx help`', 2);
  }
  if (args.versionFlag) {
    emit(ok('version', { version: packageVersion(), node: process.versions.node }), args.pretty);
    return 0;
  }
  if (args.help && command === null) {
    process.stdout.write(HELP);
    return 0;
  }

  const home = resolveHome(args.home, env);
  const manifests = (): LoadResult => {
    if (args.subprojects !== undefined) return loadManifests(path.resolve(args.subprojects));
    return typeof __DECX_MANIFESTS__ !== 'undefined' ? __DECX_MANIFESTS__ : loadManifests(SUBPROJECTS_DIR);
  };

  if (moduleId !== undefined) {
    // `-m <tool> [args...]`: every
    // argument after the id is the tool's own argv.
    try {
      const manifest = requireManifest(manifests(), moduleId);
      const state = toolState(home, manifest);
      if (!state.installed || state.bin === undefined) {
        throw new InstallError('NOT_INSTALLED', `${manifest.id} is not installed (no launcher in ${binRoot(home)})`, {
          hint: `run \`decx install ${manifest.id}\``,
        });
      }
      const spec = launchSpec(state.bin, args.toolArgs, process.platform, env);
      // Tools resolve their payload from $DECX_HOME (AFE does), so a custom
      // --home has to reach the child even when the host never exported it.
      const child = await defaultRunner({
        command: spec.command,
        args: spec.args,
        mode: 'inherit',
        env: { ...env, DECX_HOME: home },
        windowsHide: false,
        windowsVerbatimArguments: spec.windowsVerbatimArguments === true,
      });
      if (child.error !== undefined) {
        throw new InstallError('LAUNCH_FAILED', `could not launch ${state.bin}: ${child.error}`);
      }
      return child.status ?? 1;
    } catch (error) {
      return failWith(origin, error);
    }
  }

  if (command === null) {
    process.stdout.write(HELP);
    return 2;
  }
  if (command === 'help') {
    const target = args.positionals[0];
    if (target !== undefined && !KNOWN_COMMANDS.has(target)) {
      failAndExit('help', 'UNKNOWN_COMMAND', `unknown command: ${target}`, 'run `decx help`', 2);
    }
    process.stdout.write(target !== undefined ? (COMMAND_HELP[target] ?? HELP) : HELP);
    return 0;
  }
  if (command === 'version') {
    emit(ok('version', { version: packageVersion(), node: process.versions.node }), args.pretty);
    return 0;
  }
  if (!KNOWN_COMMANDS.has(command)) {
    failAndExit(command, 'UNKNOWN_COMMAND', `unknown command: ${command}`, 'run `decx help`', 2);
  }
  if (args.help) {
    process.stdout.write(COMMAND_HELP[command] ?? HELP);
    return 0;
  }

  try {
    const load = manifests();
    const id = toolId(args.positionals, command);
    const manifest = requireManifest(load, id);
    const state = toolState(home, manifest);
    if (command === 'remove') {
      if (args.positionals.length !== 1) throw new InstallError('USAGE', 'remove accepts exactly one tool id', { exitCode: 2 });
      emit(ok('remove', removeTool(manifest, home, args.links, env)), args.pretty);
      return 0;
    }
    if (command === 'update' && !state.installed) {
      throw new InstallError('NOT_INSTALLED', `${manifest.id} is not installed`, {
        hint: `run \`decx install ${manifest.id}\` first`,
      });
    }
    if (state.installed && !args.force && command !== 'update') {
      throw new InstallError('ALREADY_INSTALLED', `${manifest.id} is already installed at ${state.prefix}`, {
        hint: `use \`decx install ${manifest.id} --force\` to reinstall`,
      });
    }
    const options = installOptions(args);
    if (command === 'update') {
      options.preferRelease = true;
      if (args.releaseTag === undefined) options.version = 'latest';
    }
    const apiBase = env.DECX_GITHUB_API_BASE;
    const downloadBase = env.DECX_GITHUB_DOWNLOAD_BASE;
    const result = await installTool(manifest, options, {
      home,
      repoRoot: REPO_ROOT,
      env,
      ...(apiBase !== undefined ? { apiBase } : {}),
      ...(downloadBase !== undefined ? { downloadBase } : {}),
      platform: currentPlatformKey(),
    });
    emit(ok(command, installPayload(result)), args.pretty);
    return 0;
  } catch (error) {
    return failWith(command, error);
  }
}

/**
 * True when this file is the process entry point.  `npm` installs a bin as a
 * symlink, so the paths have to be resolved: a bare `path.resolve` compare made
 * `decx` a silent no-op when it was reached through one.
 */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  try {
    return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  run(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      process.stdout.write(`${stringify(fail(null, 'INTERNAL_ERROR', (error as Error).message))}\n`);
      process.exit(1);
    });
}
