import { isWindows } from './platform.ts';

/** Quote for the native argv parser, then protect both cmd parsing passes (%*). */
function cmdArgument(value: string): string {
  const quoted = `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`;
  const escape = (text: string): string => text.replace(/([()%!^"<>&|;, *?])/g, '^$1');
  return escape(escape(quoted));
}

/** cmd.exe cannot exec `.cmd`/`.bat` directly; wrap them with correct quoting. */
export function launchSpec(
  launcher: string,
  args: readonly string[],
  platform: string = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): { command: string; args: string[]; windowsVerbatimArguments?: boolean } {
  if (isWindows(platform) && /\.(cmd|bat)$/i.test(launcher)) {
    const command = launcher.replace(/([()%!^"<>&|;, *?])/g, '^$1');
    const quoted = [command, ...args.map(cmdArgument)].join(' ');
    return {
      command: env.ComSpec ?? env.COMSPEC ?? 'cmd.exe',
      args: ['/d', '/s', '/v:off', '/c', `"${quoted}"`],
      windowsVerbatimArguments: true,
    };
  }
  return { command: launcher, args: [...args] };
}
