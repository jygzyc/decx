/**
 * Platform identity.  Installs are keyed by two axes: the operating system
 * (`win` / `darwin` / `linux`) and the architecture (`arm64` / `amd64`), joined
 * as `<os>-<arch>` — e.g. `darwin-arm64`, `win-amd64`, `linux-amd64`.
 */

export type OsKey = 'win' | 'darwin' | 'linux';

export type ArchKey = 'arm64' | 'amd64';

export type PlatformKey = `${OsKey}-${ArchKey}`;

export const SUPPORTED_PLATFORMS: readonly PlatformKey[] = [
  'win-amd64',
  'win-arm64',
  'darwin-amd64',
  'darwin-arm64',
  'linux-amd64',
  'linux-arm64',
];

/** Maps a Node platform/arch pair onto a toolkit platform key, or null. */
export function platformKey(
  platform: string = process.platform,
  arch: string = process.arch,
): PlatformKey | null {
  const os: OsKey | null =
    platform === 'darwin' ? 'darwin' : platform === 'linux' ? 'linux' : platform === 'win32' ? 'win' : null;
  const cpu: ArchKey | null = arch === 'x64' ? 'amd64' : arch === 'arm64' ? 'arm64' : null;
  if (os === null || cpu === null) {
    return null;
  }
  const key: PlatformKey = `${os}-${cpu}`;
  return (SUPPORTED_PLATFORMS as readonly string[]).includes(key) ? key : null;
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
