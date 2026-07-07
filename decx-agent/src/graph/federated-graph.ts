/**
 * Read-only federated graph queries across multiple sessions.
 *
 * Opens session-local SQLite graphs and searches accepted facts or intents
 * without merging write state. Use this for cross-session context; all mutation
 * must still happen through the owning session graph.
 */

import { DatabaseSync } from "node:sqlite";
import type { Fact, FactStatus, GraphEvent, Intent } from "../agent/types.js";
import type { SessionManager } from "../session/session-manager.js";

export interface FederatedFact {
  sessionId: string;
  fact: Fact;
}

export interface FederatedIntent {
  sessionId: string;
  intent: Intent;
}

export interface FederatedEvent {
  sessionId: string;
  event: GraphEvent;
}

export interface SearchOptions {
  status?: FactStatus;
  query?: string;
  source?: string;
  minConfidence?: number;
  limit?: number;
}

export class FederatedGraph {
  constructor(private readonly sessionManager: SessionManager) {}

  searchFactsAcrossSessions(sessionIds: string[], opts: SearchOptions = {}): FederatedFact[] {
    const results: FederatedFact[] = [];
    const limit = opts.limit ?? 1000;
    for (const sid of sessionIds) {
      const info = this.sessionManager.info(sid);
      if (!info.exists) continue;
      const db = new DatabaseSync(info.dbPath);
      try {
        let sql = "SELECT * FROM facts WHERE 1=1";
        const params: unknown[] = [];
        if (opts.status) { sql += " AND status = ?"; params.push(opts.status); }
        if (opts.source) { sql += " AND source = ?"; params.push(opts.source); }
        if (opts.minConfidence !== undefined) { sql += " AND confidence >= ?"; params.push(opts.minConfidence); }
        if (opts.query) { sql += " AND description LIKE ?"; params.push(`%${opts.query}%`); }
        sql += " ORDER BY created_at LIMIT ?";
        params.push(limit);
        const rows = db.prepare(sql).all(...params);
        for (const row of rows) {
          results.push({
            sessionId: sid,
            fact: {
              id: String(row.id), projectId: String(row.project_id),
              description: String(row.description),
              evidence: JSON.parse(String(row.evidence_json ?? "[]")),
              source: String(row.source) as Fact["source"],
              confidence: Number(row.confidence),
              status: String(row.status) as FactStatus,
              parentIntentId: row.parent_intent_id ? String(row.parent_intent_id) : undefined,
              reviewerReason: row.reviewer_reason ? String(row.reviewer_reason) : undefined,
              stepDiscovered: row.step_discovered !== undefined && row.step_discovered !== null ? Number(row.step_discovered) : undefined,
              createdAt: String(row.created_at),
            },
          });
        }
      } finally {
        db.close();
      }
    }
    return results;
  }

  searchIntentsAcrossSessions(sessionIds: string[], query?: string, limit = 1000): FederatedIntent[] {
    const results: FederatedIntent[] = [];
    for (const sid of sessionIds) {
      const info = this.sessionManager.info(sid);
      if (!info.exists) continue;
      const db = new DatabaseSync(info.dbPath);
      try {
        let sql = "SELECT * FROM intents";
        const params: unknown[] = [];
        if (query) { sql += " WHERE description LIKE ?"; params.push(`%${query}%`); }
        sql += " ORDER BY created_at LIMIT ?";
        params.push(limit);
        const rows = db.prepare(sql).all(...params);
        for (const row of rows) {
          results.push({
            sessionId: sid,
            intent: {
              id: String(row.id), projectId: String(row.project_id),
              description: String(row.description),
              creator: String(row.creator) as Intent["creator"],
              parentFactIds: JSON.parse(String(row.parent_fact_ids_json ?? "[]")),
              status: String(row.status) as Intent["status"],
              parentIntentId: row.parent_intent_id ? String(row.parent_intent_id) : undefined,
              priority: Number(row.priority),
              createdAt: String(row.created_at),
            },
          });
        }
      } finally {
        db.close();
      }
    }
    return results;
  }

  recentEventsAcrossSessions(sessionIds: string[], limit = 100): FederatedEvent[] {
    const results: FederatedEvent[] = [];
    for (const sid of sessionIds) {
      const info = this.sessionManager.info(sid);
      if (!info.exists) continue;
      const db = new DatabaseSync(info.dbPath);
      try {
        const rows = db.prepare("SELECT * FROM events ORDER BY seq DESC LIMIT ?").all(limit);
        for (const row of rows) {
          results.push({
            sessionId: sid,
            event: {
              seq: Number(row.seq), projectId: String(row.project_id),
              type: String(row.type),
              payload: JSON.parse(String(row.payload_json ?? "{}")),
              timestamp: String(row.timestamp),
            },
          });
        }
      } finally {
        db.close();
      }
    }
    return results.sort((a, b) => b.event.seq - a.event.seq).slice(0, limit);
  }

  allSessions(): string[] {
    return this.sessionManager.listSessions();
  }
}
