import type { DatabaseSync } from "node:sqlite";
import type { WorkflowEdge, WorkflowNode } from "../core/types.js";
import { utcnow } from "./repository-rows.js";

export class WorkflowGraphRepository {
  constructor(private readonly db: DatabaseSync) {}

  node(projectId: string, kind: string, refId: string, label: string, data?: Record<string, unknown>): string {
    const id = `${kind}:${refId}`;
    this.db.prepare(`
      INSERT OR IGNORE INTO workflow_nodes (id, project_id, kind, ref_id, label, data_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, projectId, kind, refId, label, data ? JSON.stringify(data) : null, utcnow());
    return id;
  }

  edge(projectId: string, fromNodeId: string, toNodeId: string, kind: string, data?: Record<string, unknown>): void {
    const id = `${kind}:${fromNodeId}->${toNodeId}`;
    this.db.prepare(`
      INSERT OR IGNORE INTO workflow_edges (id, project_id, from_node_id, to_node_id, kind, data_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, projectId, fromNodeId, toNodeId, kind, data ? JSON.stringify(data) : null, utcnow());
  }

  nodes(projectId: string): WorkflowNode[] {
    return this.db.prepare("SELECT * FROM workflow_nodes WHERE project_id = ? ORDER BY created_at, id")
      .all(projectId)
      .map(nodeFromRow);
  }

  edges(projectId: string): WorkflowEdge[] {
    return this.db.prepare("SELECT * FROM workflow_edges WHERE project_id = ? ORDER BY created_at, id")
      .all(projectId)
      .map(edgeFromRow);
  }
}

function nodeFromRow(row: Record<string, unknown>): WorkflowNode {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    kind: String(row.kind),
    refId: String(row.ref_id),
    label: String(row.label),
    data: row.data_json ? parseJson(row.data_json) : undefined,
    createdAt: String(row.created_at),
  };
}

function edgeFromRow(row: Record<string, unknown>): WorkflowEdge {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    fromNodeId: String(row.from_node_id),
    toNodeId: String(row.to_node_id),
    kind: String(row.kind),
    data: row.data_json ? parseJson(row.data_json) : undefined,
    createdAt: String(row.created_at),
  };
}

function parseJson(value: unknown): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(String(value ?? ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
