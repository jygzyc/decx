/**
 * Platform identity.  Toolkit installs are keyed by `<os>-<arch>` using the
 * vocabulary the DECX install scripts and upstream release assets already use:
 * `macos-*` / `linux-*` / `windows-*` with `x64` / `arm64`.
 */

export type PlatformKey =
  | 'macos-x64'
  | 'macos-arm64'
  | 'linux-x64'
  | 'linux-arm64'
  | 'windows-x64'
  | 'windows-arm64';

export const SUPPORTED_PLATFORMS: readonly PlatformKey[] = [
  'macos-x64',
  'macos-arm64',
  'linux-x64',
  'linux-arm64',
  'windows-x64',
  'windows-arm64',
];

const OS_LABELS: Record<string, string> = {
  darwin: 'macOS',
  linux: 'Linux',
  win32: 'Windows',
};

/** Maps a Node platform/arch pair onto a toolkit platform key, or null. */
export function platformKey(
  platform: string = process.platform,
  arch: string = process.arch,
): PlatformKey | null {
  const os =
    platform === 'darwin'
      ? 'macos'
      : platform === 'linux'
        ? 'linux'
        : platform === 'win32'
          ? 'windows'
          : null;
  const cpu = arch === 'x64' ? 'x64' : arch === 'arm64' ? 'arm64' : null;
  if (os === null || cpu === null) {
    return null;
  }
  const key = `${os}-${cpu}`;
  return (SUPPORTED_PLATFORMS as readonly string[]).includes(key) ? (key as PlatformKey) : null;
}

/** Human label for a Node platform, e.g. `win32` -> `Windows`. */
export function osLabel(platform: string = process.platform): string {
  return OS_LABELS[platform] ?? platform;
}

export function isWindows(platform: string = process.platform): boolean {
  return platform === 'win32';
}

/** Executable suffix for the given platform (`.exe` on Windows, empty elsewhere). */
export function exeSuffix(platform: string = process.platform): string {
  return isWindows(platform) ? '.exe' : '';
}

/** The platform key of this process, as the toolkit understands it. */
export function currentPlatformKey(): PlatformKey | null {
  return platformKey();
}
