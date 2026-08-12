// Shared types for DECX CLI

export interface Session {
  name: string;
  hash: string;
  pid: number;
  port: number;
  path: string;
  startedAt: number;
  scripts?: string[];
  oem?: string;
  vendor?: string;
  rootDir?: string;
  updatedAt?: number;
}

export interface ServerJarConfig {
  path: string | null;
  version: string;
  installDir: string;
}

export interface ServerConfig {
  defaultPort: number;
  timeout: number;
}

export interface OutputConfig {
  defaultDir: string;
  decompileDir: string;
}

export interface Config {
  serverJar: ServerJarConfig;
  server: ServerConfig;
  output: OutputConfig;
}
