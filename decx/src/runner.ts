import { spawn } from 'node:child_process';
import { commandResult } from './command-result.ts';
import type { CommandResult, CommandSpec } from './install.ts';

export function defaultRunner(spec: CommandSpec): Promise<CommandResult> {
  return commandResult(spawn(spec.command, spec.args, {
    env: spec.env ?? process.env,
    stdio: spec.mode === 'inherit' ? 'inherit' : 'pipe',
    windowsHide: spec.windowsHide !== false,
    windowsVerbatimArguments: spec.windowsVerbatimArguments === true,
  }), spec);
}
