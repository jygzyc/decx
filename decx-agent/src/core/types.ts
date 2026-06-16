/**
 * Core type definitions for the agent framework.
 *
 * Design principle: schema constrains structure, not semantics.
 * - `fact.description`, `intent.description`, `link.kind` carry all domain meaning.
 * - No `fact_type` enum, no domain-specific primitives.
 * - Same schema serves vuln-hunting, reverse engineering, research, any task.
 *
 * WorkflowEvent is the ONE exception: it's an in-memory protocol object for
 * workflow rule matching, never persisted to the database.
 */

export type AgentPhase = "bootstrap" | "reason" | "explore" | "review";
export type WorkerName = string;
export type WorkerKind = "agent" | "api";
export type AgentBackendId = "opencode" | "codex" | "claude-code" | string;
export type ToolKind = "tool" | "skill";
export type WorkflowSeverity = "info" | "low" | "medium" | "high" | "critical";

// ─── Graph primitives (persisted) ───

/** Immutable observation node. */
export interface Fact {
  id: string;
  description: string;
  evidence: string[];
  source: string;
  confidence: number; // 0.0–1.0; deterministic tools emit 1.0
  createdAt: string;
}

/** Work unit / directed edge (multi-source → single-sink) with lifecycle. */
export interface Intent {
  id: string;
  fromFacts: string[]; // populated from intent_sources edge table
  to?: string; // produced fact id (or 'goal' sentinel)
  description: string;
  creator: string;
  role?: string; // which role should execute this intent (workflow rules use this)
  worker?: WorkerName;
  promptText?: string; // optional specific instruction for the worker
  status: "open" | "working" | "done" | "failed";
  priority: number;
  claimedBy?: string;
  claimedAt?: string;
  failureReason?: string;
  createdAt: string;
  concludedAt?: string;
}

/** Directed reasoning dependency between two facts (no lifecycle, no worker dispatch). */
export interface Link {
  id: string;
  projectId: string;
  fromFactId: string;
  toFactId: string;
  kind: string; // arbitrary label: enables|bypasses|calls|flows_to|...
  evidence: string[];
  createdAt: string;
}

/** Worker execution record. */
export interface Run {
  worker: WorkerName;
  role: string;
  phase: AgentPhase;
  intentId?: string;
  returncode: number;
  stdoutPreview: string;
  stderrPreview: string;
  startedAt: string;
  completedAt: string;
}

// ─── In-memory protocol objects (NOT persisted) ───

/**
 * WorkflowEvent is an in-memory signal passed from dispatcher actions to the
 * workflow rule matcher. It is never written to the database — the events
 * table was removed because dispatcher never read it for decisions.
 */
export interface WorkflowEvent {
  id: string;
  type: string;
  severity?: WorkflowSeverity;
  source?: string;
  sink?: string;
  category?: string;
  data?: Record<string, unknown>;
  createdAt: string;
  worker: WorkerName;
  phase: AgentPhase;
  intentId?: string;
}

// ─── Project aggregates ───

export interface ProjectRecord {
  id: string;
  session: string;
  name: string;
  target: string;
  goal: string;
  status: "active" | "stopped" | "completed" | "failed";
  worker: WorkerName;
  sessionDir: string;
  configPath: string;
  taskConfig: TaskConfig;
  lastReviewAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectDetail {
  project: ProjectRecord;
  facts: Fact[];
  intents: Intent[];
  links: Link[];
  runs: Run[];
}

// ─── Task configuration (task.json schema) ───

export interface TaskConfig {
  task: TaskDefinition;
  worker?: WorkerName;
  /** Canonical agent/role definitions. At load time, both `agents` and `roles` from task.json are merged into this field. */
  agents?: Record<string, AgentConfig>;
  /**
   * Backward-compat alias parsed from task.json.
   * Merged into `agents` at load time — runtime code should only look at `agents`.
   */
  roles?: Record<string, RoleConfig>;
  tools?: Record<string, ToolConfig>;
  workers: Record<string, WorkerConfig>;
  workflow: WorkflowConfig;
}

export interface TaskDefinition {
  name?: string;
  session?: string;
  target: string;
  goal: string;
  mode?: string;
}

export interface AgentConfig {
  extends?: string;
  prompt?: string;
  promptText?: string;
  instructions?: string;
  phase?: AgentPhase;
  worker?: WorkerName;
  capabilities?: string[];
  tools?: string[];
  autonomy?: RoleAutonomy;
}

/** @deprecated Use `AgentConfig` instead. Kept for backward compatibility with task.json files that use `roles`. */
export type RoleConfig = AgentConfig;

export interface ToolConfig {
  kind?: ToolKind;
  description?: string;
  instructions?: string;
  prompt?: string;
  promptText?: string;
  command?: string;
  args?: string[];
}

export interface RoleAutonomy {
  canCreateIntents?: boolean;
  canCompleteRun?: boolean;
  canFailRun?: boolean;
  canReview?: boolean;
  maxIntentsPerStep?: number;
}

export interface ReviewerConfig {
  enabled?: boolean;
  role?: string;
  worker?: WorkerName;
  everySteps?: number;
  everySeconds?: number;
  prompt?: string;
  promptText?: string;
}

export type AgentTransport = "subprocess" | "http";

export interface WorkerConfig {
  kind: WorkerKind;
  backend?: AgentBackendId;
  transport?: AgentTransport;
  command?: string;
  args?: string[];
  model?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  password?: string;
  provider?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface WorkflowConfig {
  phases: WorkflowPhase[];
  review?: ReviewerConfig;
  rules?: WorkflowRule[];
}

export interface WorkflowPhase {
  id: AgentPhase;
  agent?: string;
  role?: string;
  worker?: WorkerName;
}

export interface WorkflowRule {
  id: string;
  when: WorkflowCondition;
  then: WorkflowAction[];
}

export interface WorkflowCondition {
  eventType?: string;
  equals?: Record<string, string>;
  includes?: Record<string, string>;
  matches?: Record<string, string>;
  minSeverity?: WorkflowSeverity;
  hasFact?: string;
  intentStatus?: string;
}

export type WorkflowAction =
  | { createIntent: WorkflowCreateIntentAction }
  | { completeRun: { description: string } }
  | { failRun: { description: string } };

export interface WorkflowCreateIntentAction {
  description: string;
  agent?: string;
  role?: string;
  worker?: WorkerName;
  prompt?: string;
  promptText?: string;
  fromEvent?: boolean;
}
