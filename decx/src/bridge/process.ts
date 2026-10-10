import { spawn } from 'node:child_process';
import type { PlatformKey } from '../core/platform.ts';

export interface BridgeContext {
  home: string;
  env: NodeJS.ProcessEnv;
  platform: PlatformKey | null;
  log: (line: string) => void;
}

export interface CommandSpec {
  command: string;
  args: string[];
  mode?: 'capture' | 'stream' | 'inherit';
  env?: NodeJS.ProcessEnv;
  windowsHide?: boolean;
}

export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

export async function runCommand(
  ctx: Pick<BridgeContext, 'env'>,
  command: string,
  args: string[],
  mode: 'capture' | 'stream' = 'capture',
  extraEnv?: Record<string, string>,
): Promise<CommandResult> {
  return defaultRunner({ command, args, mode, env: { ...ctx.env, ...extraEnv } });
}

/** Execute an argv vector directly, without a shell or runtime-specific adapter. */
export function defaultRunner(spec: CommandSpec): Promise<CommandResult> {
  const child = spec.mode === 'inherit'
    ? spawn(spec.command, spec.args, { env: spec.env ?? process.env, stdio: 'inherit', windowsHide: spec.windowsHide !== false })
    : spawn(spec.command, spec.args, { env: spec.env ?? process.env, stdio: 'pipe', windowsHide: spec.windowsHide !== false });
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
