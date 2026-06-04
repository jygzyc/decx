export type AgentPhase = "bootstrap" | "reason" | "explore" | "review";
export type WorkerName = string;
export type WorkerKind = "noop" | "command" | "api";
export type WorkflowSeverity = "info" | "low" | "medium" | "high" | "critical";

export interface ArtifactInfo {
  path: string;
  fileName: string;
  kind: "handoff" | "result";
  scope: "session" | "chain";
  sourceId: string;
  sinkId: string;
  flowSig: string;
  decxSession: string;
}

export interface Fact {
  id: string;
  description: string;
  evidence: string[];
  source: string;
  createdAt: string;
}

export interface Intent {
  id: string;
  from: string[];
  to?: string;
  description: string;
  creator: string;
  role?: string;
  worker?: WorkerName;
  fromEvents?: string[];
  promptText?: string;
  status: "open" | "working" | "done" | "failed";
  createdAt: string;
  concludedAt?: string;
}

export interface Hint {
  id: string;
  content: string;
  creator: string;
  createdAt: string;
}

export interface TaskConfig {
  task: TaskDefinition;
  worker?: WorkerName;
  skills?: string[];
  roles?: Record<string, RoleConfig>;
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

export interface RoleConfig {
  extends?: string;
  prompt?: string;
  promptText?: string;
  instructions?: string;
  phase?: AgentPhase;
  worker?: WorkerName;
  capabilities?: string[];
  autonomy?: RoleAutonomy;
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

export interface WorkerConfig {
  kind: WorkerKind;
  command?: string;
  args?: string[];
  provider?: string;
  baseUrl?: string;
  model?: string;
  apiKeyEnv?: string;
  maxTokens?: number;
}

export interface WorkflowEvent {
  id: string;
  type: string;
  severity?: WorkflowSeverity;
  source?: string;
  sink?: string;
  category?: string;
  artifact?: string;
  data?: Record<string, unknown>;
  createdAt: string;
  worker: WorkerName;
  phase: AgentPhase;
  intentId?: string;
}

export interface WorkflowConfig {
  phases: WorkflowPhase[];
  review?: ReviewerConfig;
  rules?: WorkflowRule[];
}

export interface WorkflowPhase {
  id: AgentPhase;
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
  hasArtifact?: string;
  hasFact?: string;
  intentStatus?: string;
}

export type WorkflowAction =
  | { createIntent: WorkflowCreateIntentAction }
  | { completeRun: { description: string } }
  | { failRun: { description: string } };

export interface WorkflowCreateIntentAction {
  description: string;
  role?: string;
  worker?: WorkerName;
  prompt?: string;
  fromEvent?: boolean;
}

export interface WorkerRun {
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

export interface Review {
  id: string;
  projectId: string;
  worker: WorkerName;
  summary: string;
  severity?: WorkflowSeverity;
  events: WorkflowEvent[];
  createdAt: string;
}

export interface WorkflowNode {
  id: string;
  projectId: string;
  kind: string;
  refId: string;
  label: string;
  data?: Record<string, unknown>;
  createdAt: string;
}

export interface WorkflowEdge {
  id: string;
  projectId: string;
  fromNodeId: string;
  toNodeId: string;
  kind: string;
  data?: Record<string, unknown>;
  createdAt: string;
}
