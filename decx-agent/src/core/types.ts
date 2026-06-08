export type AgentPhase = "bootstrap" | "reason" | "explore" | "review";
export type WorkerName = string;
export type WorkerKind = "noop" | "command" | "model";
export type WorkerSessionStrategy = "none" | "stable" | "uuid" | "regex";
export type WorkerResponseMode = "stdout" | "jsonl-assistant-text";
export type ToolKind = "tool" | "skill";
export type WorkflowSeverity = "info" | "low" | "medium" | "high" | "critical";

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
  agent?: string;
  role?: string;
  worker?: WorkerName;
  fromEvents?: string[];
  promptText?: string;
  status: "open" | "working" | "done" | "failed";
  claimedBy?: string;
  claimedAt?: string;
  failureReason?: string;
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
  agents?: Record<string, AgentConfig>;
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

export interface WorkerConfig {
  kind: WorkerKind;
  command?: string;
  args?: string[];
  sessionStrategy?: WorkerSessionStrategy;
  sessionPattern?: string;
  responseMode?: WorkerResponseMode;
  provider?: string;
  baseUrl?: string;
  model?: string;
  apiKeyEnv?: string;
  maxTokens?: number;
  temperature?: number;
}

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

export interface WorkerRun {
  worker: WorkerName;
  agent?: string;
  role: string;
  phase: AgentPhase;
  intentId?: string;
  returncode: number;
  stdoutPreview: string;
  stderrPreview: string;
  errorKind?: string;
  workerSession?: string;
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
