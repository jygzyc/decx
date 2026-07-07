/**
 * FederationBus — cross-session insight propagation.
 *
 * Session-internal synchronization goes through the Graph and its events
 * (the source of truth). This bus is for CROSS-SESSION propagation only:
 * when a session accepts a high-value fact, records a dead-end, or produces
 * a hint worth surfacing to other sessions, it publishes a GlobalInsight
 * (summary + refs, never the full fact body).
 *
 * Other sessions consume insights read-only and may convert them into local
 * Hints/Intents — they must NOT write external facts directly into their own
 * accepted set.
 */

import { EventEmitter } from "node:events";
import type { ProjectId } from "../agent/types.js";

export interface GlobalInsightRef {
  sessionId: string;
  projectId: ProjectId;
  factId: string;
}

export interface GlobalInsight {
  id: string;
  source: GlobalInsightRef;
  summary: string;
  confidence: number;
  publishedAt: number;
}

export type GlobalInsightListener = (insight: GlobalInsight) => void;

const MAX_GLOBAL_INSIGHTS = 500;

export class FederationBus {
  private emitter = new EventEmitter();
  private insights: GlobalInsight[] = [];
  private counter = 0;

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  publishInsight(source: GlobalInsightRef, summary: string, confidence: number): GlobalInsight {
    this.counter += 1;
    const insight: GlobalInsight = {
      id: `gi_${this.counter}`,
      source,
      summary,
      confidence,
      publishedAt: Date.now(),
    };
    this.insights.push(insight);
    if (this.insights.length > MAX_GLOBAL_INSIGHTS) {
      this.insights.splice(0, this.insights.length - MAX_GLOBAL_INSIGHTS);
    }
    this.emitter.emit("insight", insight);
    return insight;
  }

  subscribeInsights(listener: GlobalInsightListener): () => void {
    this.emitter.on("insight", listener);
    return () => { this.emitter.off("insight", listener); };
  }

  recentInsights(limit = 50): GlobalInsight[] {
    return this.insights.slice(-limit);
  }

  insightsForSession(sessionId: string, limit = 50): GlobalInsight[] {
    return this.insights
      .filter((i) => i.source.sessionId !== sessionId)
      .slice(-limit);
  }

  clear(): void {
    this.insights = [];
  }
}
