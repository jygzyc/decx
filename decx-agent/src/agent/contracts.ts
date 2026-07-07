/**
 * Output contract validators.
 *
 * Each named contract (main_decision, candidate_fact, verdict, hints, stop,
 * chain) has a dedicated validator that takes a parsed WorkerEnvelope and
 * returns a typed, validated payload — or throws on shape mismatch.
 *
 * The Stage implementations and the decision applier share these validators,
 * so output enforcement is centralized rather than duplicated per stage.
 */

import type { OutputContract, Verdict, ChainRequest, SubIntentSpec } from "./types.js";
import type { HintInput } from "../graph/graph.js";
import {
  asArray,
  asNumber,
  asOptionalString,
  asString,
  expectKind,
  type WorkerEnvelope,
} from "./parse-envelope.js";
import { StageError } from "./parse-envelope.js";

// ─── main_decision (planner output) ───

export interface MainDecisionIntent {
  description: string;
  parentFactIds?: string[];
  priority?: number;
}

export interface MainDecisionFail {
  intentId: string;
  reason: string;
}

export interface MainDecision {
  createIntents: MainDecisionIntent[];
  failIntents: MainDecisionFail[];
  consumeHintIds: string[];
  concludeRun?: { description: string };
}

export function validateMainDecision(envelope: WorkerEnvelope): MainDecision {
  const data = expectKind(envelope, "decisions", "planner");

  const createRaw = asArray(data, "createIntents", "planner") as Array<Record<string, unknown>>;
  const createIntents: MainDecisionIntent[] = createRaw.map((raw) => ({
    description: asString(raw, "description", "planner"),
    parentFactIds: Array.isArray(raw.from) ? (raw.from as string[]) : undefined,
    priority: typeof raw.priority === "number" ? raw.priority : undefined,
  }));

  const failRaw = (Array.isArray(data.failIntents) ? data.failIntents : []) as Array<Record<string, unknown>>;
  const failIntents: MainDecisionFail[] = failRaw.map((raw) => ({
    intentId: asString(raw, "intentId", "planner"),
    reason: asString(raw, "reason", "planner"),
  }));

  const concludeRaw = data.concludeRun as Record<string, unknown> | undefined;
  const concludeRun = concludeRaw && typeof concludeRaw.description === "string"
    ? { description: concludeRaw.description }
    : undefined;

  return { createIntents, failIntents, consumeHintIds: [], concludeRun };
}

// ─── candidate_fact (explorer output) ───

export interface CandidateFact {
  description: string;
  evidence: string[];
  confidence: number;
}

export function validateCandidateFact(envelope: WorkerEnvelope, stage: string): CandidateFact {
  const data = expectKind(envelope, "fact", stage);
  return {
    description: asString(data, "description", stage),
    evidence: Array.isArray(data.evidence) ? (data.evidence as string[]) : [],
    confidence: asNumber(data, "confidence", stage, 0.7),
  };
}

// ─── verdict (evaluator output) ───

export function validateVerdict(envelope: WorkerEnvelope, stage: string): Verdict {
  const data = expectKind(envelope, "verdict", stage);
  const decisionRaw = asString(data, "decision", stage);
  if (decisionRaw !== "accept" && decisionRaw !== "reject" && decisionRaw !== "demote" && decisionRaw !== "block") {
    throw new StageError(
      `verdict decision must be accept|reject|demote|block, got: ${decisionRaw}`,
      stage,
    );
  }
  const reason = asString(data, "reason", stage);
  const confidenceRaw = data.confidence;
  const confidence = typeof confidenceRaw === "number" && Number.isFinite(confidenceRaw) ? confidenceRaw : undefined;
  const requiredConditions = Array.isArray(data.requiredConditions)
    ? (data.requiredConditions as unknown[]).filter((v): v is string => typeof v === "string" && v.length > 0)
    : undefined;
  return { decision: decisionRaw, reason, confidence, requiredConditions };
}

// ─── hints (metacog output) ───

export function validateHints(envelope: WorkerEnvelope, stage: string, creator: string): { hints: HintInput[] } {
  const data = expectKind(envelope, "hints", stage);
  const hintsRaw = asArray(data, "hints", stage) as Array<Record<string, unknown>>;
  const hints: HintInput[] = hintsRaw.map((raw) => ({
    content: asString(raw, "content", stage),
    creator: creator as HintInput["creator"],
  }));
  return { hints };
}

// ─── stop (metacog output) ───

export function validateStop(envelope: WorkerEnvelope, stage: string): { reason: string } {
  const data = expectKind(envelope, "stop", stage);
  return { reason: asString(data, "reason", stage) };
}

// ─── chain (explorer chain request) ───

export function validateChain(envelope: WorkerEnvelope, stage: string): ChainRequest {
  const data = expectKind(envelope, "chain", stage);
  const reason = asString(data, "reason", stage);
  const subsRaw = asArray(data, "subIntents", stage) as Array<Record<string, unknown>>;
  const subIntents: SubIntentSpec[] = subsRaw.map((raw) => ({
    description: asString(raw, "description", stage),
    role: asOptionalString(raw, "role"),
    priority: typeof raw.priority === "number" ? raw.priority : undefined,
  }));
  const waitMode = (data.waitMode === "any" ? "any" : "all") as "all" | "any";
  return { reason, subIntents, waitMode };
}

// ─── contract registry ───

export const CONTRACTS: Record<OutputContract, (envelope: WorkerEnvelope, stage: string) => unknown> = {
  main_decision: (e, _s) => validateMainDecision(e),
  candidate_fact: (e, s) => validateCandidateFact(e, s),
  verdict: (e, s) => validateVerdict(e, s),
  hints: (e, s) => validateHints(e, s, "system"),
  stop: (e, s) => validateStop(e, s),
  chain: (e, s) => validateChain(e, s),
};
