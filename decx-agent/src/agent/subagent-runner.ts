/**
 * SubagentRunner — universal execution engine for all subagent profiles.
 *
 * Replaces the four hardcoded stage files (planner/explorer/evaluator/metacog).
 * The runner is role-agnostic: it assembles a prompt from (1) the profile's
 * prompt file, (2) dynamic graph context via ContextBuilder, and (3) a
 * role-specific extra block provided by the caller. It then calls the worker,
 * parses the envelope, and validates the output via the named contract.
 *
 * The caller (SessionLoop / MainAgent / MetacogSupervisor) supplies the
 * role-specific promptExtra (e.g. "## Current Intent\n..." for explorer,
 * "## Candidate Under Review\n..." for evaluator) and pattern-matches on the
 * returned discriminated union to apply graph mutations.
 */

import type {
  Fact,
  Hint,
  ProjectId,
  SubagentProfile,
  TaskConfig,
  Verdict,
  WorkerName,
} from "./types.js";
import type { Graph } from "../graph/graph.js";
import type { WorkerPool } from "../worker/worker-runtime.js";
import { parseEnvelope, StageError, type WorkerEnvelope } from "./parse-envelope.js";
import {
  validateCandidateFact,
  validateChain,
  validateHints,
  validateMainDecision,
  validateStop,
  validateVerdict,
  type CandidateFact,
  type MainDecision,
} from "./contracts.js";
import { buildDynamicContext } from "./context-builder.js";
import { PromptLoader } from "../config/prompt-loader.js";
import { ContextLedger } from "./context-ledger.js";
import type { WorkerSessionManager } from "../worker/session-manager.js";

export interface SubagentRunRequest {
  profile: SubagentProfile;
  profileId: string;
  projectId: ProjectId;
  graph: Graph;
  workerPool: WorkerPool;
  config: TaskConfig;
  promptExtra: string;
  enrichedContext?: Fact[];
  hints?: Hint[];
  recentVerdicts?: Array<{ factId: string; verdict: Verdict; intentId?: string }>;
  promptLoader?: PromptLoader;
  workerNameOverride?: WorkerName;
  contextLedger?: ContextLedger;
  sessionManager?: WorkerSessionManager;
  intent?: import("./types.js").Intent;
  candidate?: Fact;
}

export type SubagentOutput =
  | { kind: "decisions"; decision: MainDecision }
  | { kind: "fact"; fact: CandidateFact }
  | { kind: "chain"; chain: ReturnType<typeof validateChain> }
  | { kind: "verdict"; verdict: Verdict }
  | { kind: "hints"; hints: ReturnType<typeof validateHints> }
  | { kind: "stop"; stop: ReturnType<typeof validateStop> };

export function runSubagent(req: SubagentRunRequest): Promise<SubagentOutput> {
  return runSubagentWithText(req).then((r) => r.output);
}

export interface SubagentRunWithTextResult {
  output: SubagentOutput;
  rawText: string;
  prompt: string;
  usedDelta: boolean;
}

export async function runSubagentWithText(req: SubagentRunRequest): Promise<SubagentRunWithTextResult> {
  const { profile, projectId, graph, workerPool, config, promptExtra } = req;

  const project = graph.getProject(projectId);
  if (!project) throw new StageError(`project not found: ${projectId}`, profile.role);

  const workerName = req.workerNameOverride
    ?? profile.runtime.workers?.[0]
    ?? profile.runtime.worker;
  const workerConfig = config.workers[workerName];
  if (!workerConfig) {
    throw new StageError(`worker config missing for ${profile.role}: ${workerName}`, profile.role);
  }

  const loader = req.promptLoader ?? new PromptLoader({ baseDir: project.sessionDir });
  const resolved = loader.load(profile.prompt);
  if (!resolved.fromConfig) {
    throw new StageError(
      `prompt file not loaded for profile "${req.profileId}". Ensure prompt.file points to an existing file.`,
      profile.role,
    );
  }

  const useSession = profile.sessionReuse === true;
  const ledger = useSession ? req.contextLedger : undefined;
  const recentVerdicts = req.recentVerdicts ?? [];

  let contextBlock: string;
  let usedDelta = false;

  if (ledger && useSession) {
    const delta = ledger.computeDelta(projectId, req.profileId, graph, recentVerdicts);
    if (delta.isDelta) {
      contextBlock = delta.deltaBlock;
      usedDelta = true;
    } else {
      contextBlock = buildDynamicContext({
        projectId, graph, spec: profile.context,
        enrichedContext: req.enrichedContext,
        hints: req.hints, recentVerdicts,
        intent: req.intent, candidate: req.candidate,
      });
    }
  } else {
    contextBlock = buildDynamicContext({
      projectId, graph, spec: profile.context,
      enrichedContext: req.enrichedContext,
      hints: req.hints, recentVerdicts,
      intent: req.intent, candidate: req.candidate,
    });
  }

  const prompt = [resolved.preamble, contextBlock, promptExtra].filter(Boolean).join("\n\n");

  const result = await workerPool.execute({
    prompt,
    config: workerConfig,
    workerName,
    projectId,
    maxOutputTokens: profile.maxOutputTokens,
    sessionId: useSession && req.sessionManager
      ? req.sessionManager.get(projectId, req.profileId)?.sessionId
      : undefined,
  });

  if (result.returncode !== 0) {
    throw new StageError(
      `${profile.role} worker failed: ${result.stderr ?? "no stderr"}`,
      profile.role,
    );
  }

  if (ledger && useSession) {
    const progress = graph.progress(projectId);
    ledger.sync(projectId, req.profileId, graph, recentVerdicts, progress);
  }

  const envelope = parseEnvelope(result.text, profile.role);
  const output = validateOutput(envelope, profile, req.profileId);
  return { output, rawText: result.text, prompt, usedDelta };
}

const CONTRACT_KIND_MAP: Record<string, Set<string>> = {
  main_decision: new Set(["decisions"]),
  candidate_fact: new Set(["fact", "chain"]),
  verdict: new Set(["verdict"]),
  hints: new Set(["hints", "stop"]),
};

function validateOutput(
  envelope: WorkerEnvelope,
  profile: SubagentProfile,
  profileId: string,
): SubagentOutput {
  const stage = profile.role;
  const contract = profile.output.contract;
  const allowed = CONTRACT_KIND_MAP[contract];
  if (allowed && !allowed.has(envelope.kind)) {
    throw new StageError(
      `profile "${profileId}" (contract="${contract}") returned kind="${envelope.kind}", expected one of: ${[...allowed].join(", ")}`,
      stage,
    );
  }
  switch (envelope.kind) {
    case "decisions":
      return { kind: "decisions", decision: validateMainDecision(envelope) };
    case "fact":
      return { kind: "fact", fact: validateCandidateFact(envelope, stage) };
    case "chain":
      return { kind: "chain", chain: validateChain(envelope, stage) };
    case "verdict":
      return { kind: "verdict", verdict: validateVerdict(envelope, stage) };
    case "hints":
      return { kind: "hints", hints: validateHints(envelope, stage, profileId) };
    case "stop":
      return { kind: "stop", stop: validateStop(envelope, stage) };
    default:
      throw new StageError(
        `unexpected envelope kind "${envelope.kind}" for profile "${profileId}"`,
        stage,
      );
  }
}

/**
 * Build the role-specific promptExtra block for each builtin role.
 * Callers use these to avoid duplicating formatting logic.
 */

export function plannerExtra(
  hints?: Hint[],
  recentVerdicts?: Array<{ factId: string; verdict: Verdict; intentId?: string }>,
): string {
  const lines: string[] = [];

  if (hints && hints.length > 0) {
    lines.push("## Hints Requiring Response");
    lines.push(
      "For each hint: create a new intent pursuing it, fail an existing intent whose direction " +
        "it contradicts, or ignore if irrelevant. A stop-explorer hint means: fail the targeted intent.",
    );
    for (const h of hints) {
      const tgt = h.targetIntentId ? ` (target: ${h.targetIntentId})` : "";
      lines.push(`- [${h.id}] (${h.kind}, from ${h.creator})${tgt}: ${h.content}`);
    }
  }

  if (recentVerdicts && recentVerdicts.length > 0) {
    lines.push("## Recent Evaluator Verdicts");
    lines.push(
      "If a candidate was rejected, decide whether its intent should be failed (dead-end confirmed), " +
        "retried differently, or replaced. If accepted, decide what to investigate next.",
    );
    for (const v of recentVerdicts) {
      lines.push(`- ${v.factId} (${v.intentId ?? "no intent"}): ${v.verdict.decision} — ${v.verdict.reason}`);
    }
  }

  return lines.join("\n");
}

export function explorerExtra(
  intentId: string,
  intentDescription: string,
  parentFactIds: string[],
  insights: Fact[],
  isResume: boolean,
): string {
  const lines: string[] = [];
  if (isResume) {
    lines.push("## Resume Context");
    lines.push(
      "This is a RESUMED execution. Previously you requested additional context via a chain. " +
        "The enriched context section above contains the results of those sub-investigations.",
    );
  }
  if (insights.length > 0) {
    lines.push("## Recent Discoveries by Other Explorers");
    lines.push("These facts were just discovered by parallel explorers. Use them — avoid duplicating their work.");
    for (const f of insights) lines.push(`- ${f.id}: ${f.description}`);
  }
  lines.push("## Current Intent");
  lines.push(`ID: ${intentId}`);
  lines.push(`Description: ${intentDescription}`);
  if (parentFactIds.length > 0) {
    lines.push(`Triggered by facts: ${parentFactIds.join(", ")}`);
  }
  return lines.join("\n");
}

export function evaluatorExtra(candidate: Fact): string {
  const lines: string[] = ["## Candidate Fact Under Review"];
  lines.push(`ID: ${candidate.id}`);
  lines.push(`Description: ${candidate.description}`);
  lines.push(`Confidence claimed: ${candidate.confidence}`);
  if (candidate.evidence.length > 0) {
    lines.push("Evidence:");
    for (const e of candidate.evidence) lines.push(`- ${e}`);
  }
  return lines.join("\n");
}

export function metacogExtra(trigger: string): string {
  return `## Trigger\nThis metacog run was triggered by: ${trigger}`;
}
