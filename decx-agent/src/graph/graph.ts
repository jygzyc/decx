/**
 * Graph interface shared by all decx-agent storage backends.
 *
 * Defines the state protocol for projects, facts, intents, hints, directives,
 * links, events, leases, and progress. SessionLoops and stages depend on this
 * interface instead of a specific in-memory or SQLite implementation.
 */

import type {
  ChainRequest,
  Directive,
  DirectiveId,
  DirectiveInput,
  Fact,
  FactId,
  FactStatus,
  GraphEvent,
  Hint,
  HintId,
  Intent,
  IntentId,
  IntentStatus,
  ISOTime,
  Link,
  LinkId,
  Progress,
  Project,
  ProjectId,
  ProjectStatus,
  RunId,
  RunStatus,
  SubagentRun,
  SubagentRunInput,
  TaskConfig,
  Verdict,
  WorkerName,
} from "../agent/types.js";

export interface HintInput {
  content: string;
  creator: Hint["creator"];
  kind?: Hint["kind"];
  targetIntentId?: IntentId;
  expiresAt?: ISOTime;
}

export interface ProjectInput {
  session: string;
  name: string;
  target: string;
  goal: string;
  worker: WorkerName;
  sessionDir: string;
  configPath: string;
  taskConfig: TaskConfig;
}

export interface FactInput {
  description: string;
  evidence?: string[];
  source: Fact["source"];
  confidence?: number;
  parentIntentId?: IntentId;
}

export interface IntentInput {
  description: string;
  creator: Intent["creator"];
  parentFactIds?: FactId[];
  parentIntentId?: IntentId;
  priority?: number;
}

export interface LinkInput {
  fromFactId: FactId;
  toFactId: FactId;
  kind: string;
  evidence?: string[];
}

export interface Graph {
  createProject(input: ProjectInput): Project;
  getProject(idOrSession: string): Project | undefined;
  listProjects(status?: ProjectStatus): Project[];
  updateProjectStatus(id: ProjectId, status: ProjectStatus): void;
  touchProject(id: ProjectId): void;

  addFact(projectId: ProjectId, input: FactInput): Fact;
  getFact(projectId: ProjectId, factId: FactId): Fact | undefined;
  facts(projectId: ProjectId, status?: FactStatus): Fact[];
  pendingCandidates(projectId: ProjectId): Fact[];
  resolveFact(projectId: ProjectId, factId: FactId, verdict: Verdict): void;

  addIntent(projectId: ProjectId, input: IntentInput): Intent;
  getIntent(projectId: ProjectId, intentId: IntentId): Intent | undefined;
  intents(projectId: ProjectId, status?: IntentStatus): Intent[];
  claimIntent(projectId: ProjectId, intentId: IntentId, workerId: string, leaseMs: number): Intent;
  releaseIntent(projectId: ProjectId, intentId: IntentId): void;
  concludeIntent(projectId: ProjectId, intentId: IntentId, factId?: FactId): void;
  failIntent(projectId: ProjectId, intentId: IntentId, reason: string, recordDeadEnd?: boolean, killedBy?: Intent["killedBy"]): void;
  chainIntent(projectId: ProjectId, intentId: IntentId, chain: ChainRequest): IntentId[];
  resumeChainedIntent(projectId: ProjectId, intentId: IntentId): void;
  isDeadEnd(projectId: ProjectId, description: string): boolean;
  sweepExpiredLeases(): number;

  addHint(projectId: ProjectId, input: HintInput): Hint;
  unconsumedHints(projectId: ProjectId): Hint[];
  consumeHint(projectId: ProjectId, hintId: HintId): void;

  addDirective(projectId: ProjectId, input: DirectiveInput): Directive;
  unconsumedDirectives(projectId: ProjectId): Directive[];
  consumeDirective(projectId: ProjectId, directiveId: DirectiveId): void;

  addLink(projectId: ProjectId, input: LinkInput): Link;
  links(projectId: ProjectId): Link[];

  createSubagentRun(projectId: ProjectId, input: SubagentRunInput): SubagentRun;
  updateSubagentRun(projectId: ProjectId, runId: RunId, patch: Partial<Pick<SubagentRun,
    "status" | "outputSummary" | "errorMessage" | "factId" | "startedAt" | "finishedAt"
    | "usedDelta" | "inputTokens" | "outputTokens">>): void;
  getSubagentRun(projectId: ProjectId, runId: RunId): SubagentRun | undefined;
  subagentRuns(projectId: ProjectId, filter?: { profileId?: string; status?: RunStatus }): SubagentRun[];

  logEvent(projectId: ProjectId, type: string, payload?: Record<string, unknown>): GraphEvent;
  events(projectId: ProjectId, sinceSeq?: number, limit?: number): GraphEvent[];

  progress(projectId: ProjectId): Progress;

  transaction<T>(fn: () => T): T;
}

export function routeHash(description: string): string {
  const normalized = description.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 120);
  let h = 5381;
  for (let i = 0; i < normalized.length; i++) {
    h = ((h << 5) + h + normalized.charCodeAt(i)) | 0;
  }
  return `rh_${(h >>> 0).toString(16)}`;
}

export function now(): ISOTime {
  return new Date().toISOString();
}

export function newProjectId(): ProjectId {
  return `proj_${Math.random().toString(16).slice(2, 10)}`;
}

export function newRunId(): RunId {
  return `run_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 6)}`;
}
