/**
 * WorkerSessionManager — tracks reusable worker sessions per (project, profile).
 *
 * When sessionReuse is enabled on a profile, the runner asks this manager for
 * an existing session before calling the worker. Session reuse means the
 * worker (e.g. opencode-http, codex --resume, claude --resume) retains prior
 * conversation context, so the runner can send delta-only prompts.
 *
 * The manager itself is transport-agnostic — it just maps keys to opaque
 * session IDs. The backend adapters interpret the session ID.
 */

import type { ProjectId } from "../agent/types.js";

export interface WorkerSession {
  sessionId: string;
  createdAt: number;
  callCount: number;
  lastUsedAt: number;
}

export class WorkerSessionManager {
  private sessions = new Map<string, WorkerSession>();

  private key(projectId: ProjectId, profileId: string): string {
    return `${projectId}::${profileId}`;
  }

  get(projectId: ProjectId, profileId: string): WorkerSession | undefined {
    return this.sessions.get(this.key(projectId, profileId));
  }

  acquire(projectId: ProjectId, profileId: string, factory: () => string): WorkerSession {
    const k = this.key(projectId, profileId);
    let session = this.sessions.get(k);
    if (!session) {
      session = {
        sessionId: factory(),
        createdAt: Date.now(),
        callCount: 0,
        lastUsedAt: Date.now(),
      };
      this.sessions.set(k, session);
    }
    session.callCount += 1;
    session.lastUsedAt = Date.now();
    return session;
  }

  rotate(projectId: ProjectId, profileId: string, factory: () => string): WorkerSession {
    const k = this.key(projectId, profileId);
    const session: WorkerSession = {
      sessionId: factory(),
      createdAt: Date.now(),
      callCount: 0,
      lastUsedAt: Date.now(),
    };
    this.sessions.set(k, session);
    return session;
  }

  release(projectId: ProjectId, profileId: string): void {
    this.sessions.delete(this.key(projectId, profileId));
  }

  releaseProject(projectId: ProjectId): void {
    const prefix = `${projectId}::`;
    for (const k of this.sessions.keys()) {
      if (k.startsWith(prefix)) this.sessions.delete(k);
    }
  }

  list(): WorkerSession[] {
    return [...this.sessions.values()];
  }
}
