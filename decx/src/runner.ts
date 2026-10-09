import { spawn } from 'node:child_process';
import type { CommandResult, CommandSpec } from './install.ts';

/** Node runner; native builds omit the unsupported Windows argv option. */
export async function defaultRunner(spec: CommandSpec): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(spec.command, spec.args, {
      env: spec.env ?? process.env,
      stdio: spec.mode === 'inherit' ? 'inherit' : 'pipe',
      windowsHide: spec.windowsHide !== false,
      windowsVerbatimArguments: spec.windowsVerbatimArguments === true,
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
