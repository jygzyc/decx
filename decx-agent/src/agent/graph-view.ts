/**
 * Graph view rendering — controls how much of the session graph appears in a
 * subagent's prompt.
 *
 * Profiles declare a `context.graphView` policy:
 *   - full:          all accepted facts, rejected facts, intents, hints
 *   - focused:       accepted facts (capped) + recent rejected facts + relevant intents
 *   - evidence-only: only accepted facts with evidence, no intents or hints
 *   - summary:       fact counts + intent counts + recent verdicts, no fact bodies
 *
 * `maxFacts` caps the number of facts rendered (oldest trimmed first) to bound
 * prompt size on long runs.
 */

import type { Fact, GraphView, Intent, Progress, Verdict } from "./types.js";
import { tierFacts, renderTieredFacts, DEFAULT_TIER_OPTIONS } from "./fact-tiering.js";

const TIER_THRESHOLD = 15;

export interface GraphViewInput {
  acceptedFacts: Fact[];
  rejectedFacts?: Fact[];
  blockedFacts?: Fact[];
  candidateFacts?: Fact[];
  openIntents?: Intent[];
  claimedIntents?: Intent[];
  chainedIntents?: Intent[];
  hints?: Array<{ id: string; content: string; creator: string; kind: string; targetIntentId?: string }>;
  progress?: Progress;
  recentVerdicts?: Array<{ factId: string; verdict: Verdict; intentId?: string }>;
  enrichedContext?: Fact[];
}

export interface GraphViewOptions {
  view: GraphView;
  maxFacts?: number;
  includeDeadEnds?: boolean;
  includeProgress?: boolean;
}

export function renderGraphView(input: GraphViewInput, options: GraphViewOptions): string {
  switch (options.view) {
    case "full":
      return renderFull(input, options);
    case "focused":
      return renderFocused(input, options);
    case "evidence-only":
      return renderEvidenceOnly(input, options);
    case "summary":
      return renderSummary(input, options);
    default:
      return renderFull(input, options);
  }
}

function cap<T>(items: T[], max: number | undefined): T[] {
  if (max === undefined || items.length <= max) return items;
  return items.slice(items.length - max);
}

function renderFull(input: GraphViewInput, options: GraphViewOptions): string {
  const sections: string[] = [];
  const rejectedFacts = input.rejectedFacts ?? [];
  const blockedFacts = input.blockedFacts ?? [];

  if (options.includeProgress && input.progress) {
    sections.push(renderProgressBlock(input.progress));
  }

  if (input.acceptedFacts.length > 0) {
    if (input.acceptedFacts.length > TIER_THRESHOLD) {
      const currentStep = input.progress?.stepsExecuted ?? input.acceptedFacts.length;
      const tiered = tierFacts(input.acceptedFacts, currentStep);
      sections.push(renderTieredFacts(tiered));
    } else {
      sections.push("## Accepted Facts");
      for (const f of cap(input.acceptedFacts, options.maxFacts)) {
        sections.push(`- ${fmtFact(f)}`);
      }
    }
  }

  if (blockedFacts.length > 0) {
    sections.push("## Blocked facts (conditional, low weight)");
    for (const f of cap(blockedFacts, 10)) {
      const conditions = f.requiredConditions?.length ? ` prerequisites: ${f.requiredConditions.join("; ")}` : "";
      sections.push(`- ${f.id}: ${f.description} — ${f.reviewerReason ?? "blocked"}${conditions}`);
    }
  }

  if (options.includeDeadEnds !== false && rejectedFacts.length > 0) {
    sections.push("## Rejected Facts (dead-ends)");
    for (const f of cap(rejectedFacts, 10)) {
      sections.push(`- ${f.id}: ${f.description} — ${f.reviewerReason ?? "rejected"}`);
    }
  }

  const intents = [
    ...(input.openIntents ?? []),
    ...(input.claimedIntents ?? []),
    ...(input.chainedIntents ?? []),
  ];
  if (intents.length > 0) {
    sections.push("## Current Intents");
    for (const i of input.openIntents ?? []) sections.push(`- [open] ${i.id}: ${i.description}`);
    for (const i of input.claimedIntents ?? []) sections.push(`- [claimed] ${i.id}: ${i.description}`);
    for (const i of input.chainedIntents ?? []) sections.push(`- [chained] ${i.id}: ${i.description}`);
  }

  if (input.hints && input.hints.length > 0) {
    sections.push("## Hints");
    for (const h of input.hints) {
      sections.push(`- [${h.id}] (${h.kind}, from ${h.creator}): ${h.content}`);
    }
  }

  if (input.recentVerdicts && input.recentVerdicts.length > 0) {
    sections.push("## Recent Verdicts");
    for (const v of input.recentVerdicts) {
      sections.push(`- ${v.factId}: ${v.verdict.decision} — ${v.verdict.reason}`);
    }
  }

  return sections.join("\n");
}

function renderFocused(input: GraphViewInput, options: GraphViewOptions): string {
  const sections: string[] = [];
  const rejectedFacts = input.rejectedFacts ?? [];

  const ctx = [...input.acceptedFacts, ...(input.enrichedContext ?? [])];
  if (ctx.length > 0) {
    if (ctx.length > TIER_THRESHOLD) {
      const currentStep = input.progress?.stepsExecuted ?? ctx.length;
      const tiered = tierFacts(ctx, currentStep);
      sections.push(renderTieredFacts(tiered));
    } else {
      sections.push("## Context (accepted facts)");
      for (const f of cap(ctx, options.maxFacts ?? 50)) {
        sections.push(`- ${fmtFact(f)}`);
      }
    }
  }

  if (options.includeDeadEnds !== false && rejectedFacts.length > 0) {
    sections.push("## Known Dead-Ends");
    for (const f of cap(rejectedFacts, 10)) {
      sections.push(`- ${f.id}: ${f.description}${f.reviewerReason ? ` — ${f.reviewerReason}` : ""}`);
    }
  }

  return sections.join("\n");
}

function renderEvidenceOnly(input: GraphViewInput, options: GraphViewOptions): string {
  const sections: string[] = [];
  const withEvidence = input.acceptedFacts.filter((f) => f.evidence.length > 0);
  if (withEvidence.length > 0) {
    sections.push("## Accepted Facts (evidence)");
    for (const f of cap(withEvidence, options.maxFacts ?? 30)) {
      sections.push(`- ${f.id}: ${f.description}`);
      for (const e of f.evidence) sections.push(`  - ${e}`);
    }
  }
  return sections.join("\n");
}

function renderSummary(input: GraphViewInput, _options: GraphViewOptions): string {
  const sections: string[] = [];
  if (input.progress) {
    sections.push(renderProgressBlock(input.progress));
  } else {
    const rejectedCount = input.rejectedFacts?.length ?? 0;
    sections.push(`## Summary`);
    sections.push(`- Accepted facts: ${input.acceptedFacts.length}`);
    sections.push(`- Rejected facts: ${rejectedCount}`);
  }

  if (input.recentVerdicts && input.recentVerdicts.length > 0) {
    sections.push("## Recent Verdicts");
    for (const v of input.recentVerdicts.slice(-5)) {
      sections.push(`- ${v.factId}: ${v.verdict.decision}`);
    }
  }
  return sections.join("\n");
}

function renderProgressBlock(progress: Progress): string {
  const lines = [
    "## Progress",
    `- Accepted facts: ${progress.acceptedFacts}`,
    `- Candidate facts: ${progress.candidateFacts}`,
    `- Rejected facts: ${progress.rejectedFacts}`,
    `- Blocked facts: ${progress.blockedFacts}`,
    `- Open intents: ${progress.openIntents}`,
    `- Chained intents: ${progress.chainedIntents}`,
    `- Steps: ${progress.stepsExecuted}`,
    `- Stagnation: ${progress.stagnationLevel}`,
  ];
  return lines.join("\n");
}

function fmtFact(f: Fact): string {
  const conf = f.confidence < 1.0 ? ` (${Math.round(f.confidence * 100)}%)` : "";
  return `${f.id}${conf}: ${f.description}`;
}
