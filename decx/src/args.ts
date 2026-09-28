/* Manager argument parsing. -m terminates parsing and preserves the tool's argv verbatim. */

export const KNOWN_COMMANDS = new Set(['install', 'update', 'remove', 'version', 'help']);

export interface CliArgs {
  command: string | null;
  positionals: string[];
  module?: string;
  toolArgs: string[];
  home?: string;
  subprojects?: string;
  links?: string;
  releaseTag?: string;
  force: boolean;
  noLinks: boolean;
  pretty: boolean;
  help: boolean;
  versionFlag: boolean;
  error?: string;
}

const GLOBAL_VALUE_FLAGS: Record<string, 'home' | 'subprojects' | 'links'> = {
  '--home': 'home', '--prefix': 'home', '--subprojects': 'subprojects', '--links': 'links',
};
const RELEASE_VALUE_FLAGS: Record<string, 'releaseTag'> = {
  '--version': 'releaseTag', '--release-tag': 'releaseTag',
};
const BOOLEAN_FLAGS: Record<string, 'force' | 'noLinks' | 'pretty'> = {
  '--force': 'force', '--no-links': 'noLinks', '--pretty': 'pretty',
};

export function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = {
    command: null, positionals: [], toolArgs: [], force: false,
    noLinks: false, pretty: false, help: false, versionFlag: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (token === '-m' || token === '--module') {
      if (args.command !== null) {
        args.error = `unknown option: ${token}`;
        return args;
      }
      const id = argv[index + 1];
      if (id === undefined || (id.startsWith('-') && id !== '-')) {
        args.error = `missing value for ${token}`;
        return args;
      }
      args.module = id;
      args.toolArgs = argv.slice(index + 2);
      return args;
    }
    if (token === '-h' || token === '--help') {
      args.help = true;
      continue;
    }
    if ((token === '-V' || token === '--version') && args.command !== 'install' && args.command !== 'update') {
      args.versionFlag = true;
      continue;
    }
    if (!token.startsWith('-') || token === '-') {
      if (args.command === null) {
        // An unknown first word is a tool name. Stop parsing here: every
        // following flag/argument belongs to that tool, not to decx.
        if (!KNOWN_COMMANDS.has(token)) {
          args.module = token;
          args.toolArgs = argv.slice(index + 1);
          return args;
        }
        args.command = token;
      } else args.positionals.push(token);
      continue;
    }
    const globalKey = GLOBAL_VALUE_FLAGS[token];
    const releaseKey = args.command === 'install' || args.command === 'update' ? RELEASE_VALUE_FLAGS[token] : undefined;
    const boolKey = BOOLEAN_FLAGS[token];
    if (globalKey === undefined && releaseKey === undefined && boolKey === undefined) {
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
    if (globalKey !== undefined) args[globalKey] = value;
    else if (releaseKey !== undefined) args[releaseKey] = value;
  }
  return args;
}
