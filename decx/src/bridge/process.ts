import { execa } from 'execa';
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

/** Execute an argv vector without shell interpolation; keep installer logs off stdout. */
export async function defaultRunner(spec: CommandSpec): Promise<CommandResult> {
  const inherit = spec.mode === 'inherit';
  const output = spec.mode === 'stream' ? ['pipe', process.stderr] as const : 'pipe';
  const result = await execa(spec.command, spec.args, {
    env: spec.env ?? process.env,
    extendEnv: false,
    stdin: inherit ? 'inherit' : 'ignore',
    stdout: inherit ? 'inherit' : output,
    stderr: inherit ? 'inherit' : output,
    windowsHide: spec.windowsHide !== false,
    reject: false,
    stripFinalNewline: false,
    maxBuffer: Infinity,
  });
  return {
    status: result.exitCode ?? null,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    ...(result.failed && result.exitCode === undefined && result.signal === undefined
      ? { error: result.shortMessage } : {}),
  };
}
