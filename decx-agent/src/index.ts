/**
 * decx-agent — public entry point.
 */

// Core types
export type {
  ProjectId, FactId, IntentId, HintId, LinkId, DirectiveId, RunId, RoleId, ISOTime,
  Project, ProjectStatus, Fact, FactStatus, Intent, IntentStatus,
  ChainState, Hint, HintKind, Link, GraphEvent, Verdict, Progress, ChainRequest,
  SubIntentSpec, Directive, DirectiveInput, DirectiveKind,
  SubagentRun, SubagentRunInput, RunStatus,
  WorkerName, WorkerKind, WorkerConfig, TaskConfig,
  SubagentProfile, RuntimeSpec, PromptSpec, ContextSpec, GraphView,
  Permission, OutputContract, OutputSpec,
  BuiltinProfiles, ControlConfig,
  WorkflowConfig, AgentBackendId, ToolKind,
} from "./agent/types.js";
export { DEFAULT_LIMITS, DEFAULT_METACOG_TRIGGERS, BUILTIN_ROLES, BUILTIN_PERMISSIONS } from "./agent/types.js";

// Graph interface and helpers
export type { Graph, ProjectInput, FactInput, IntentInput, HintInput, LinkInput } from "./graph/graph.js";
export { routeHash, now, newProjectId, newRunId } from "./graph/graph.js";

// Graph implementations
export { InMemoryGraph } from "./graph/in-memory-graph.js";
export { SqliteGraph } from "./graph/sqlite-graph.js";
export { SessionManager } from "./session/session-manager.js";
export type { SessionInfo } from "./session/session-manager.js";
export { FederatedGraph } from "./graph/federated-graph.js";
export type { FederatedFact, FederatedIntent, FederatedEvent, SearchOptions } from "./graph/federated-graph.js";

export { FederationBus } from "./graph/federation-bus.js";
export type { GlobalInsight, GlobalInsightRef, GlobalInsightListener } from "./graph/federation-bus.js";
export { defaultConfig } from "./config/default-config.js";
export { loadConfig } from "./config/task-config.js";
export type { LoadedConfig } from "./config/task-config.js";
export { normalizeProfile } from "./config/profile-loader.js";
export { PromptLoader } from "./config/prompt-loader.js";
export type { ResolvedPrompt, PromptLoaderOptions } from "./config/prompt-loader.js";

export { HttpServer } from "./server/http-server.js";
export type { HttpServerOptions } from "./server/http-server.js";

// Worker layer
export type { WorkerPool, WorkerRequest, WorkerResult } from "./worker/worker-runtime.js";
export { NullWorkerPool } from "./worker/worker-runtime.js";
export { MockWorker } from "./worker/mock-worker.js";
export { AgentDriverPool } from "./worker/agent-driver-pool.js";

// Agent protocol layer
export { StageError } from "./agent/parse-envelope.js";
export type { WorkerEnvelope } from "./agent/parse-envelope.js";
export { parseEnvelope, expectKind, asArray, asString, asOptionalString, asNumber } from "./agent/parse-envelope.js";
export { PermissionChecker, PermissionDeniedError } from "./agent/permissions.js";
export {
  validateMainDecision, validateCandidateFact, validateVerdict,
  validateHints, validateStop, validateChain, CONTRACTS,
} from "./agent/contracts.js";
export type {
  MainDecision, MainDecisionIntent, MainDecisionFail, CandidateFact,
} from "./agent/contracts.js";
export { renderGraphView } from "./agent/graph-view.js";
export type { GraphViewInput, GraphViewOptions } from "./agent/graph-view.js";
export {
  buildDynamicContext, estimateContextTokens, isContextNearFull,
} from "./agent/context-builder.js";
export type { BuildContextOptions } from "./agent/context-builder.js";
export { ContextLedger } from "./agent/context-ledger.js";
export type { LedgerEntry, DeltaResult } from "./agent/context-ledger.js";
export { tierFacts, renderTieredFacts, DEFAULT_TIER_OPTIONS } from "./agent/fact-tiering.js";
export type { TierOptions, TieredFacts } from "./agent/fact-tiering.js";
export { WorkerSessionManager } from "./worker/session-manager.js";
export type { WorkerSession } from "./worker/session-manager.js";
export {
  runSubagent, runSubagentWithText,
  plannerExtra, explorerExtra, evaluatorExtra, metacogExtra,
} from "./agent/subagent-runner.js";
export type { SubagentRunRequest, SubagentOutput, SubagentRunWithTextResult } from "./agent/subagent-runner.js";
export { MainAgent } from "./agent/main-agent.js";
export type { MainAgentContext, MainAgentRunInput, MainAgentResult } from "./agent/main-agent.js";
export { applyMainDecision } from "./agent/decision-applier.js";
export type { DecisionApplierResult, ApplyDecisionContext } from "./agent/decision-applier.js";

// Session runtime
export { SessionLoop } from "./session/session-loop.js";
export type { StepResult, RunOptions } from "./session/session-loop.js";
export { ProjectLockManager } from "./session/project-lock.js";
export { MetacogSupervisor } from "./session/metacog-supervisor.js";
export { GlobalSupervisor } from "./session/supervisor.js";
export type { RegisteredSession, GlobalTickResult, GlobalSupervisorOptions } from "./session/supervisor.js";

// Runtime
export { AgentRuntime } from "./app/agent-runtime.js";
export type { AgentRuntimeOptions } from "./app/agent-runtime.js";
