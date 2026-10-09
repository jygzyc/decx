import { spawn } from 'node:child_process';
import type { CommandResult, CommandSpec } from '../install.ts';

/** scriptc's native spawn surface; Windows cmd launches use the Win32 adapter. */
export async function defaultRunner(spec: CommandSpec): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spec.mode === 'inherit'
      ? spawn(spec.command, spec.args, {
        env: spec.env ?? process.env, stdio: 'inherit',
        windowsHide: spec.windowsHide !== false,
      })
      : spawn(spec.command, spec.args, {
        env: spec.env ?? process.env, stdio: 'pipe',
        windowsHide: spec.windowsHide !== false,
      });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (spec.mode === 'stream') process.stderr.write(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      if (spec.mode === 'stream') process.stderr.write(chunk);
    });
    child.on('error', (error) => resolve({ status: null, stdout, stderr, error: error.message }));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}
