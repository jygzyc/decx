/**
 * ProjectLockManager — per-project mutex for serializing graph mutations
 * within a single project while allowing cross-project concurrency.
 *
 * Single-project serialization is required because Graph mutations
 * (claim, chain, resolve) assume no concurrent modifications from competing
 * SessionLoop steps on the same project. Cross-project, we want full
 * parallelism.
 */

import type { ProjectId } from "../agent/types.js";

export class ProjectLockManager {
  private chains = new Map<ProjectId, Promise<unknown>>();
  private pending = new Map<ProjectId, number>();

  /**
   * Acquire the project lock and run fn. Resolves with fn's result.
   * Re-entry from the same async chain is NOT supported — a project lock
   * acquisition blocks until the previous holder releases.
   */
  async acquire<T>(projectId: ProjectId, fn: () => Promise<T>): Promise<T> {
    // Track pending acquirers for diagnostics.
    this.pending.set(projectId, (this.pending.get(projectId) ?? 0) + 1);

    const previous = this.chains.get(projectId) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });

    this.chains.set(projectId, previous.then(() => next));

    try {
      await previous;
      return await fn();
    } finally {
      release();
      const remaining = (this.pending.get(projectId) ?? 1) - 1;
      if (remaining <= 0) {
        this.pending.delete(projectId);
        this.chains.delete(projectId);
      } else {
        this.pending.set(projectId, remaining);
      }
    }
  }

  /** Number of acquirers currently queued or running for the project. */
  pendingCount(projectId: ProjectId): number {
    return this.pending.get(projectId) ?? 0;
  }
}
