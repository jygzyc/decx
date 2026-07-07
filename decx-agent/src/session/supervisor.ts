/**
 * GlobalSupervisor — process-level controller for multiple sessions.
 *
 * Per the subagent control-plane plan, multi-task scheduling should NOT use a
 * single global MainAgent. Instead, one GlobalSupervisor manages N
 * session-local SessionLoops, each with its own MainAgent/Planner and Metacog.
 *
 * Responsibilities:
 *   - Register/unregister SessionLoops by session id
 *   - Provide a global tick that steps all active loops concurrently
 *   - Enforce a global worker concurrency quota across all sessions
 *   - Own the cross-session FederationBus
 *
 * The supervisor does NOT own per-session planning, graph mutation, or metacog
 * scheduling — those remain session-local for context isolation, independent
 * resume/pause/stop, and clear permission boundaries.
 */

import type { ProjectId } from "../agent/types.js";
import type { SessionLoop, StepResult } from "./session-loop.js";
import { FederationBus } from "../graph/federation-bus.js";

export interface RegisteredSession {
  id: string;
  loop: SessionLoop;
}

export interface GlobalTickResult {
  sessionId: string;
  result: StepResult;
}

export interface GlobalSupervisorOptions {
  globalMaxConcurrent?: number;
  federationBus?: FederationBus;
}

export class GlobalSupervisor {
  private sessions = new Map<string, RegisteredSession>();
  readonly federationBus: FederationBus;
  readonly globalMaxConcurrent: number;

  constructor(options: GlobalSupervisorOptions = {}) {
    this.federationBus = options.federationBus ?? new FederationBus();
    this.globalMaxConcurrent = options.globalMaxConcurrent ?? Infinity;
  }

  register(id: string, loop: SessionLoop): void {
    if (this.sessions.has(id)) {
      throw new Error(`session already registered: ${id}`);
    }
    this.sessions.set(id, { id, loop });
  }

  unregister(id: string): void {
    this.sessions.delete(id);
  }

  get(id: string): SessionLoop | undefined {
    return this.sessions.get(id)?.loop;
  }

  listSessions(): RegisteredSession[] {
    return [...this.sessions.values()];
  }

  /**
   * Step every active session concurrently. Each SessionLoop internally
   * serializes per-project via ProjectLockManager; the supervisor only adds
   * a global concurrency hint (consumed by worker pools that opt in).
   */
  async tick(): Promise<GlobalTickResult[]> {
    const active = [...this.sessions.values()];
    const results = await Promise.allSettled(
      active.map(async ({ id, loop }) => {
        const stepResults = await loop.tick();
        return { sessionId: id, result: stepResults[0] ?? { type: "idle" as const, reason: "no active projects" } };
      }),
    );
    return results.map((r, idx) => {
      const sessionId = active[idx]!.id;
      if (r.status === "fulfilled") return r.value;
      return {
        sessionId,
        result: { type: "failed" as const, reason: `exception: ${(r.reason as Error)?.message ?? String(r.reason)}` },
      };
    });
  }

  async stepSession(sessionId: string, projectId: ProjectId): Promise<StepResult | undefined> {
    const loop = this.sessions.get(sessionId)?.loop;
    if (!loop) return undefined;
    return loop.step(projectId);
  }
}
