#!/usr/bin/env node
/**
 * `decx` -- install the DECX tools and launch them.  It is a thin wrapper: the
 * three commands either move files into DECX_HOME (`install`), report what is
 * there (`list`) or exec a tool's launcher (`run`), and the tools themselves
 * are never translated.
 *
 * Data commands print one JSON object on stdout (`help` and `run` print text or
 * the tool's own output); failures use `{ok:false,error:{code,message,hint}}`
 * and exit 1 (runtime error) or 2 (usage error).
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { binRoot, resolveHome } from './config.ts';
import { InstallError, installTool, type InstallOptions, type InstallResult } from './install.ts';
import { toolState } from './inspect.ts';
import { fail, ok, stringify } from './json.ts';
import { loadManifests, type LoadResult, type ToolManifest } from './manifest.ts';
import { currentPlatformKey, isWindows } from './platform.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUBPROJECTS_DIR = path.resolve(HERE, '..', '..', 'subprojects');
const REPO_ROOT = path.resolve(HERE, '..', '..');

const HELP = `decx -- DECX toolkit installer and manager

usage: decx <command> [options]

commands:
  install <tool>       download or build a tool into DECX_HOME (JSON)
  run <tool> [args]    run the tool's launcher, passing args through
  version              print the CLI version (JSON)
  help [command]       print help

options:
  --home/--prefix <dir>  install root (default $DECX_HOME, else ~/.decx)
  --subprojects <dir>  tool subproject directory (default <repo>/subprojects)
  --pretty             indent the JSON output
  -h, --help           print help (decx <command> --help for one command)
  -V, --version        print the CLI version

install options:
  --version <tag>      release tag to install (e.g. 1.508 or tools-v0.1.0)
  --from-source        build the vendored checkout with cargo
  --source <dir>       checkout to build (implies --from-source)
  --force              reinstall over an existing install, replacing links
  --links <dir>        PATH link directory (default ~/.local/bin)
  --no-links           install without PATH links

exit codes: 0 success, 1 runtime error, 2 usage error
`;

const COMMAND_HELP: Record<string, string> = {
  install: `usage: decx install <tool> [options]

Install one tool into DECX_HOME: the executables go to $DECX_HOME/bin, the
payload to $DECX_HOME/share/<tool>, and a PATH link to ~/.local/bin (or
--links).  Release installs download the platform asset (sha256-verified when
the release publishes checksums); kind "python-venv" tools build a private
virtualenv over the pinned checkout; a manifest with a buildable source block
can be built with --from-source instead.  Nothing is committed until every
check, including the tool's own verify command, has succeeded.

options: --version <tag>, --from-source, --source <dir>, --force,
         --links <dir>, --no-links, --home <dir>, --subprojects <dir>, --pretty
`,
  run: `usage: decx run [options] <tool> [args...]

Run a tool's launcher with the remaining arguments passed through untouched.
Options before the tool id belong to decx (--home, --subprojects, --pretty); every
argument after it belongs to the tool.

options: --home <dir>, --subprojects <dir>, --pretty
`,
};

const KNOWN_COMMANDS = new Set(['install', 'run', 'version', 'help']);

interface CliArgs {
  command: string | null;
  /** `install <tool>`: the tool id.  `run <tool> args...`: the id plus its argv. */
  positionals: string[];
  runArgs: string[];
  home?: string;
  subprojects?: string;
  links?: string;
  releaseTag?: string;
  source?: string;
  fromSource: boolean;
  force: boolean;
  noLinks: boolean;
  pretty: boolean;
  help: boolean;
  versionFlag: boolean;
  error?: string;
}

const GLOBAL_VALUE_FLAGS: Record<string, 'home' | 'subprojects' | 'links'> = {
  '--home': 'home',
  '--prefix': 'home',
  '--subprojects': 'subprojects',
  '--links': 'links',
};

const INSTALL_VALUE_FLAGS: Record<string, 'releaseTag' | 'source'> = {
  '--version': 'releaseTag',
  '--release-tag': 'releaseTag',
  '--source': 'source',
};

const BOOLEAN_FLAGS: Record<string, 'fromSource' | 'force' | 'noLinks' | 'pretty'> = {
  '--from-source': 'fromSource',
  '--force': 'force',
  '--no-links': 'noLinks',
  '--pretty': 'pretty',
};

export function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = {
    command: null,
    positionals: [],
    runArgs: [],
    fromSource: false,
    force: false,
    noLinks: false,
    pretty: false,
    help: false,
    versionFlag: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    // Everything after `run <tool>` is the tool's own argv, flags included.
    if (args.command === 'run' && args.positionals.length > 0) {
      args.runArgs.push(...argv.slice(index));
      return args;
    }
    if (token === '-h' || token === '--help') {
      args.help = true;
      continue;
    }
    if ((token === '-V' || token === '--version') && args.command !== 'install') {
      args.versionFlag = true;
      continue;
    }
    if (!token.startsWith('-') || token === '-') {
      if (args.command === null) {
        args.command = token;
      } else {
        args.positionals.push(token);
      }
      continue;
    }
    const globalKey = GLOBAL_VALUE_FLAGS[token];
    const installKey = args.command === 'install' ? INSTALL_VALUE_FLAGS[token] : undefined;
    const boolKey = BOOLEAN_FLAGS[token];
    if (globalKey === undefined && installKey === undefined && boolKey === undefined) {
      args.error = `unknown option: ${token}`;
      return args;
    }
    if (boolKey !== undefined) {
      args[boolKey] = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || (value.startsWith('-') && value !== '-')) {
      args.error = `missing value for ${token}`;
      return args;
    }
    index += 1;
    if (globalKey !== undefined) {
      args[globalKey] = value;
    } else if (installKey !== undefined) {
      args[installKey] = value;
    }
  }
  return args;
}

function packageVersion(): string {
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

function failWith(command: string, error: unknown): number {
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
    ...(args.fromSource ? { fromSource: true } : {}),
    ...(args.source !== undefined ? { source: args.source } : {}),
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

/** cmd.exe cannot exec `.cmd`/`.bat` directly; wrap them with correct quoting. */
export function launchSpec(
  launcher: string,
  args: readonly string[],
  platform: string = process.platform,
): { command: string; args: string[] } {
  if (isWindows(platform) && /\.(cmd|bat)$/i.test(launcher)) {
    const quoted = [launcher, ...args].map((part) => `"${part.replaceAll('"', '""')}"`).join(' ');
    return { command: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', `"${quoted}"`] };
  }
  return { command: launcher, args: [...args] };
}

export async function run(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const args = parseArgs(argv);
  const command = args.command;
  if (args.error !== undefined) {
    failAndExit(command, 'USAGE', args.error, 'run `decx help`', 2);
  }
  if (args.versionFlag) {
    emit(ok('version', { version: packageVersion(), node: process.versions.node }), args.pretty);
    return 0;
  }
  if (args.help && command === null) {
    process.stdout.write(HELP);
    return 0;
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

  const home = resolveHome(args.home, env);
  const subprojectsDir = args.subprojects !== undefined ? path.resolve(args.subprojects) : SUBPROJECTS_DIR;
  try {
    const load = loadManifests(subprojectsDir);
    const id = toolId(args.positionals, command);
    const manifest = requireManifest(load, id);
    if (command === 'run') {
      const state = toolState(home, manifest);
      if (!state.installed || state.bin === undefined) {
        throw new InstallError('NOT_INSTALLED', `${manifest.id} is not installed (no launcher in ${binRoot(home)})`, {
          hint: `run \`decx install ${manifest.id}\``,
        });
      }
      const spec = launchSpec(state.bin, args.runArgs);
      const child = spawnSync(spec.command, spec.args, { stdio: 'inherit', env, windowsHide: false });
      if (child.error !== undefined) {
        throw new InstallError('LAUNCH_FAILED', `could not launch ${state.bin}: ${child.error.message}`);
      }
      return child.status ?? 1;
    }
    const state = toolState(home, manifest);
    if (state.installed && !args.force) {
      throw new InstallError('ALREADY_INSTALLED', `${manifest.id} is already installed at ${state.prefix}`, {
        hint: `use \`decx install ${manifest.id} --force\` to reinstall`,
      });
    }
    const result = await installTool(manifest, installOptions(args), {
      home,
      repoRoot: REPO_ROOT,
      env,
      platform: currentPlatformKey(),
    });
    emit(ok('install', installPayload(result)), args.pretty);
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
