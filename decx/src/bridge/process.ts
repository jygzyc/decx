import { execa, type Options } from 'execa';

export type CommandOptions = Pick<Options, 'env' | 'windowsHide'> & {
  mode?: 'capture' | 'stream' | 'inherit';
};

/** Execa owns process mechanics; DECX only selects environment and output policy. */
export function runCommand(
  command: string,
  args: string[],
  { mode = 'capture', env = process.env, windowsHide = true }: CommandOptions = {},
) {
  const inherit = mode === 'inherit';
  const output = mode === 'stream' ? ['pipe', process.stderr] as const : 'pipe';
  return execa(command, args, {
    env,
    extendEnv: false,
    stdin: inherit ? 'inherit' : 'ignore',
    stdout: inherit ? 'inherit' : output,
    stderr: inherit ? 'inherit' : output,
    windowsHide,
    reject: false,
    stripFinalNewline: false,
    maxBuffer: Infinity,
  });
}
