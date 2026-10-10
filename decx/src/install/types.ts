import type { LaunchEntry } from '../bridge/launch.ts';
import type { PlatformKey } from '../core/platform.ts';
import type { LinkOutcome } from './links.ts';

export type InstallMethod = 'release download' | 'python venv';

export interface InstallContext {
  /** DECX_HOME root; the tool prefix is `<home>/share/<id>`. */
  home: string;
  env?: NodeJS.ProcessEnv;
  /** Overrides the host platform key (tests use it to pin an asset). */
  platform?: PlatformKey | null;
  apiBase?: string;
  downloadBase?: string;
}

export interface InstallOptions {
  /** Explicit release tag or version; `1.544` and `kuna-v1.544` are normalised. */
  version?: string;
  /** Link directory for the PATH entries; `--links`/`$DECX_LINKS_DIR`, else ~/.local/bin. */
  links?: string;
  /** Skip creating PATH links entirely. */
  noLinks?: boolean;
  /** Replace files in the store or link directory that decx did not create. */
  force?: boolean;
}

export interface InstallResult {
  id: string;
  method: InstallMethod;
  prefix: string;
  binDir: string;
  launcher: string;
  binaries: string[];
  version?: string;
  releaseTag?: string;
  releaseSource?: string;
  asset?: string;
  specsAsset?: string;
  specsInstalled?: number;
  checksum?: string;
  provenance: Record<string, string>;
  pathHint: string;
  /** PATH links created or refreshed by this install. */
  links?: LinkOutcome[];
  linkDir?: string;
}

export interface StagedOutcome {
  entry: LaunchEntry;
  /** Runs after the payload reaches its permanent path, while backups still exist. */
  initialize?: () => Promise<void>;
  provenance: Record<string, string>;
  binaries: string[];
  launcherName: string;
  method: InstallMethod;
  version?: string;
  releaseTag?: string;
  releaseSource?: string;
  asset?: string;
  specsAsset?: string;
  specsInstalled?: number;
  checksum?: string;
}
