// Shared types for DECX CLI

export interface Session {
  name: string;
  hash: string;
  pid: number;
  port: number;
  path: string;
  startedAt: number;
  scripts?: string[];
}

export interface Config {
  serverJar: { version: string };
  server: { defaultPort: number };
}
