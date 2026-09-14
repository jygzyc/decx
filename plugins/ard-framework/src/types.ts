/**
 * Shared types for the DECX framework plugin.
 *
 * The plugin ABI is the in-process contract documented in
 * `plugins/README.md`: the CLI hands one request object to `handle()` and
 * expects one response envelope back. These types describe both sides plus the
 * framework artifact/layout structures shared by the command implementations.
 */
import type { AdbClient } from "./adb";

/** One plugin invocation, built by the CLI from the registry command. */
export interface PluginRequest {
  /** Protocol version the CLI speaks (`1`). */
  protocol?: number;
  /** Full command path inside the plugin, e.g. `["framework", "process"]`. */
  command?: string[];
  /** Registry-keyed flag values; repeatable flags arrive as arrays. */
  args?: PluginArgs;
  /** Positional arguments after flag parsing. */
  positionals?: string[];
  /** Execution context; `home` is the resolved DECX_HOME. */
  context?: PluginContext;
}

/** Flag values keyed by registry argument id. */
export type PluginArgs = Record<string, string | string[] | undefined>;

export interface PluginContext {
  home?: string;
  pluginDir?: string;
  [key: string]: unknown;
}

export interface PluginErrorPayload {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

/** Response envelope returned by `handle()`. */
export interface PluginResponse {
  ok: boolean;
  data?: unknown;
  error?: PluginErrorPayload;
}

/** Recorded metadata for one framework output directory. */
export interface FrameworkArtifact {
  name: string;
  oem: string;
  vendor: string;
  rootDir: string;
  jarPath: string;
  updatedAt: number;
}

/** Resolved collection/processing layout. */
export interface FrameworkLayout {
  sourceDir: string;
  outDir: string;
  outTmpDir: string;
  artifact: FrameworkArtifact;
}

/** Inputs accepted by `resolveFrameworkLayout`. */
export interface FrameworkLayoutRequest {
  home: string;
  oem?: string;
  vendor?: string;
  sourceDir?: string;
  outDir?: string;
  device?: boolean;
  serialRequested?: boolean;
  adb?: AdbClient | null;
}

/** Summary written as `data.artifact` for collect/process. */
export interface ArtifactSummary {
  session: string;
  oem: string;
  vendor: string;
  jarPath: string;
}
