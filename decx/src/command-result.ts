import type { ChildProcess } from 'node:child_process';
import type { CommandResult, CommandSpec } from './install.ts';

export function commandResult(child: ChildProcess, spec: CommandSpec): Promise<CommandResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
      if (spec.mode === 'stream') process.stderr.write(chunk);
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
      if (spec.mode === 'stream') process.stderr.write(chunk);
    });
    child.on('error', (error) => resolve({ status: null, stdout, stderr, error: error.message }));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}
