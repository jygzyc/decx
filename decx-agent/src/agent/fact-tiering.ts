/**
 * Fact tiering — classifies accepted facts into hot/warm/cold tiers and
 * renders each tier at a different compression level.
 *
 *   hot:   most recently discovered facts (within `hotSteps` of current step)
 *          → full description + evidence
 *   warm:  older but within `warmMaxFacts` limit
 *          → ID + one-line summary (description truncated to 60 chars)
 *   cold:  oldest facts beyond warmMaxFacts
 *          → only ID, not rendered unless specifically requested
 *
 * Additionally, when the warm tier exceeds `compressThreshold`, the oldest
 * batch of warm facts is replaced by a single "Findings Summary" block that
 * condenses their descriptions into one paragraph. This is the periodic
 * compression mechanism.
 *
 * The tiering reads `stepDiscovered` from the fact if available (Graph stores
 * it via the step counter); otherwise falls back to insertion order.
 */

import type { Fact, ProjectId } from "./types.js";
import type { Graph } from "../graph/graph.js";

export interface TierOptions {
  hotSteps: number;
  warmMaxFacts: number;
  compressThreshold: number;
}

export const DEFAULT_TIER_OPTIONS: TierOptions = {
  hotSteps: 10,
  warmMaxFacts: 20,
  compressThreshold: 30,
};

export interface TieredFacts {
  hot: Fact[];
  warm: Fact[];
  cold: Fact[];
  summary?: string;
}

export function tierFacts(
  facts: Fact[],
  currentStep: number,
  options: TierOptions = DEFAULT_TIER_OPTIONS,
): TieredFacts {
  if (facts.length === 0) return { hot: [], warm: [], cold: [] };

  const sorted = [...facts].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const hotCutoff = Math.max(0, currentStep - options.hotSteps);

  const hot: Fact[] = [];
  const warm: Fact[] = [];

  for (let i = 0; i < sorted.length; i++) {
    const step = factStep(sorted[i]!, currentStep, sorted.length - i);
    if (step >= hotCutoff) {
      hot.push(sorted[i]!);
    } else {
      warm.push(sorted[i]!);
    }
  }

  let summary: string | undefined;
  let warmResult = warm;
  if (warm.length > options.compressThreshold) {
    const compressCount = warm.length - options.warmMaxFacts;
    const toCompress = warm.slice(0, compressCount);
    warmResult = warm.slice(compressCount);
    summary = compressFacts(toCompress);
  }

  return { hot, warm: warmResult, cold: [], summary };
}

function factStep(fact: Fact, fallback: number, offset: number): number {
  if (typeof fact.stepDiscovered === "number" && fact.stepDiscovered >= 0) return fact.stepDiscovered;
  return Math.max(0, fallback - offset);
}

function compressFacts(facts: Fact[]): string {
  const descriptions = facts.map((f) => truncate(factSummary(f), 50));
  return `Findings summary (${facts.length} earlier facts): ${descriptions.join("; ")}.`;
}

function factSummary(f: Fact): string {
  const evidence = f.evidence.length > 0 ? ` (evidence: ${f.evidence.length})` : "";
  return `${f.description}${evidence}`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + "...";
}

export function renderTieredFacts(tiered: TieredFacts): string {
  const lines: string[] = [];

  if (tiered.summary) {
    lines.push("## Earlier Findings (compressed)");
    lines.push(tiered.summary);
  }

  if (tiered.warm.length > 0) {
    lines.push("## Prior Findings");
    for (const f of tiered.warm) {
      lines.push(`- ${f.id}: ${truncate(f.description, 60)}`);
    }
  }

  if (tiered.hot.length > 0) {
    lines.push("## Recent Findings");
    for (const f of tiered.hot) {
      const conf = f.confidence < 1.0 ? ` (${Math.round(f.confidence * 100)}%)` : "";
      lines.push(`- ${f.id}${conf}: ${f.description}`);
    }
  }

  return lines.join("\n");
}
