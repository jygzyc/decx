/**
 * Session registry for decx-agent graph stores.
 *
 * Maps task sessions to filesystem locations, creates/open SQLite graph files,
 * and lists/deletes saved sessions. Runtime state remains per-session; this
 * manager only locates and lifecycle-manages those stores.
 */

import { mkdirSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SqliteGraph } from "../graph/sqlite-graph.js";
import type { Graph } from "../graph/graph.js";

export interface SessionInfo {
  sessionId: string;
  dbPath: string;
  dir: string;
  exists: boolean;
}

export class SessionManager {
  constructor(private readonly baseDir: string) {}

  sessionDir(sessionId: string): string {
    return join(this.baseDir, sessionId);
  }

  dbPath(sessionId: string): string {
    return join(this.sessionDir(sessionId), "analysis.db");
  }

  info(sessionId: string): SessionInfo {
    const dir = this.sessionDir(sessionId);
    const dbPath = this.dbPath(sessionId);
    return { sessionId, dbPath, dir, exists: existsSync(dbPath) };
  }

  listSessions(): string[] {
    if (!existsSync(this.baseDir)) return [];
    return readdirSync(this.baseDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((name) => existsSync(join(this.baseDir, name, "analysis.db")))
      .sort();
  }

  open(sessionId: string): Graph {
    const dir = this.sessionDir(sessionId);
    mkdirSync(dir, { recursive: true });
    return new SqliteGraph(this.dbPath(sessionId));
  }

  openReadOnly(sessionId: string): Graph {
    const info = this.info(sessionId);
    if (!info.exists) throw new Error(`session db not found: ${sessionId}`);
    const ro = new SqliteGraph(info.dbPath);
    return ro;
  }

  delete(sessionId: string): void {
    const dir = this.sessionDir(sessionId);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
}
