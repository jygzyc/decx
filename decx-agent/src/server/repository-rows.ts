import type {
  AgentPhase,
  ArtifactInfo,
  Fact,
  Hint,
  Intent,
  Review,
  TaskConfig,
  WorkerName,
  WorkerRun,
  WorkflowEvent,
  WorkflowSeverity,
} from "../core/types.js";
import type { ProjectRecord } from "./repository-types.js";

export function projectFromRow(row: Record<string, unknown>): ProjectRecord {
  return {
    id: String(row.id),
    session: String(row.session),
    name: String(row.name),
    target: String(row.target),
    goal: String(row.goal),
    status: String(row.status) as ProjectRecord["status"],
    worker: String(row.worker) as WorkerName,
    sessionDir: String(row.session_dir),
    artifactDir: String(row.artifact_dir),
    configPath: String(row.config_path),
    taskConfig: parseJson(row.config_json, {}) as TaskConfig,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function factFromRow(row: Record<string, unknown>): Fact {
  return {
    id: String(row.id),
    description: String(row.description),
    evidence: parseJsonArray(row.evidence_json),
    source: String(row.source),
    createdAt: String(row.created_at),
  };
}

export function intentFromRow(row: Record<string, unknown>): Intent {
  return {
    id: String(row.id),
    from: parseJsonArray(row.from_json),
    to: row.to_fact_id ? String(row.to_fact_id) : undefined,
    description: String(row.description),
    creator: String(row.creator),
    role: String(row.role),
    worker: row.worker ? String(row.worker) as WorkerName : undefined,
    promptText: row.prompt_text ? String(row.prompt_text) : undefined,
    fromEvents: parseJsonArray(row.from_events_json),
    status: String(row.status) as Intent["status"],
    createdAt: String(row.created_at),
    concludedAt: row.concluded_at ? String(row.concluded_at) : undefined,
  };
}

export function hintFromRow(row: Record<string, unknown>): Hint {
  return {
    id: String(row.id),
    content: String(row.content),
    creator: String(row.creator),
    createdAt: String(row.created_at),
  };
}

export function eventFromRow(row: Record<string, unknown>): WorkflowEvent {
  return {
    id: String(row.id),
    type: String(row.type),
    severity: row.severity ? String(row.severity) as WorkflowSeverity : undefined,
    source: row.source ? String(row.source) : undefined,
    sink: row.sink ? String(row.sink) : undefined,
    category: row.category ? String(row.category) : undefined,
    artifact: row.artifact ? String(row.artifact) : undefined,
    data: row.data_json ? parseJson(row.data_json, {}) as Record<string, unknown> : undefined,
    worker: String(row.worker) as WorkerName,
    phase: String(row.phase) as AgentPhase,
    intentId: row.intent_id ? String(row.intent_id) : undefined,
    createdAt: String(row.created_at),
  };
}

export function reviewFromRow(row: Record<string, unknown>): Review {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    worker: String(row.worker) as WorkerName,
    summary: String(row.summary),
    severity: row.severity ? String(row.severity) as WorkflowSeverity : undefined,
    events: parseJson(row.events_json, []) as WorkflowEvent[],
    createdAt: String(row.created_at),
  };
}

export function artifactFromRow(row: Record<string, unknown>): ArtifactInfo {
  return {
    path: String(row.path),
    fileName: String(row.file_name),
    kind: String(row.kind) as ArtifactInfo["kind"],
    scope: String(row.scope) as ArtifactInfo["scope"],
    sourceId: String(row.source_id),
    sinkId: String(row.sink_id),
    flowSig: String(row.flow_sig),
    decxSession: String(row.decx_session),
  };
}

export function workerRunFromRow(row: Record<string, unknown>): WorkerRun {
  return {
    worker: String(row.worker) as WorkerName,
    role: String(row.role),
    phase: String(row.phase) as AgentPhase,
    intentId: row.intent_id ? String(row.intent_id) : undefined,
    returncode: Number(row.returncode),
    stdoutPreview: String(row.stdout_preview),
    stderrPreview: String(row.stderr_preview),
    startedAt: String(row.started_at),
    completedAt: String(row.completed_at),
  };
}

function parseJsonArray(value: unknown): string[] {
  return parseJson(value, []) as string[];
}

function parseJson(value: unknown, fallback: unknown): unknown {
  try {
    return JSON.parse(String(value ?? ""));
  } catch {
    return fallback;
  }
}

export function utcnow(): string {
  return new Date().toISOString();
}
