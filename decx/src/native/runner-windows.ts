import type { CommandResult, CommandSpec } from '../install.ts';
import { defaultRunner as runSpawn } from './runner.ts';
import { runWindowsVerbatim } from './windows-process.ts';

export async function defaultRunner(spec: CommandSpec): Promise<CommandResult> {
  if (spec.windowsVerbatimArguments === true) return await runWindowsVerbatim(spec);
  return await runSpawn(spec);
}
