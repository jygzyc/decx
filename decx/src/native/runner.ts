import { spawn } from 'node:child_process';
import { commandResult } from '../command-result.ts';
import type { CommandResult, CommandSpec } from '../install.ts';

// scriptc 0.2.7 requires literal stdio options and omits windowsVerbatimArguments.
export function defaultRunner(spec: CommandSpec): Promise<CommandResult> {
  const child = spec.mode === 'inherit'
    ? spawn(spec.command, spec.args, {
      env: spec.env ?? process.env, stdio: 'inherit',
      windowsHide: spec.windowsHide !== false,
    })
    : spawn(spec.command, spec.args, {
      env: spec.env ?? process.env, stdio: 'pipe',
      windowsHide: spec.windowsHide !== false,
    });
  return commandResult(child, spec);
}
