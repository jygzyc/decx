/**
 * Context builder — assembles the dynamic prompt context for a subagent.
 *
 * Given a SubagentProfile's ContextSpec and the current graph state, produces
 * a rendered graph-view section. The caller (SubagentRunner / Stage) prepends
 * the profile's static role preamble (loaded by PromptLoader) before this
 * dynamic section.
 *
 * The context policy controls token budget: `graphView` picks the rendering
 * strategy, `maxFacts` caps fact count, `includeDeadEnds` and `includeProgress`
 * toggle optional blocks. `rotateOnContextFull` is a signal the metacog
 * supervisor reads to decide whether to rotate the run when context exceeds a
 * threshold.
 */

import type { ContextSpec, Fact, Hint, Intent, Progress, Verdict, ProjectId } from "./types.js";
import type { Graph } from "../graph/graph.js";
import { renderGraphView, type GraphViewInput, type GraphViewOptions } from "./graph-view.js";

export interface BuildContextOptions {
  projectId: ProjectId;
  graph: Graph;
  spec?: ContextSpec;
  enrichedContext?: Fact[];
  insights?: Fact[];
  hints?: Hint[];
  recentVerdicts?: Array<{ factId: string; verdict: Verdict; intentId?: string }>;
  intent?: Intent;
  candidate?: Fact;
}

export function buildDynamicContext(options: BuildContextOptions): string {
  const { projectId, graph, spec } = options;

  const viewOptions: GraphViewOptions = {
    view: spec?.graphView ?? "full",
    maxFacts: spec?.maxFacts,
    includeDeadEnds: spec?.includeDeadEnds ?? true,
    includeProgress: spec?.includeProgress ?? false,
  };

  let acceptedFacts = graph.facts(projectId, "accepted");

  if (spec?.relevanceScope === "chain") {
    const rootIds = collectRootFactIds(options);
    if (rootIds.length > 0) {
      acceptedFacts = filterRelevantFacts(graph, projectId, acceptedFacts, rootIds, 2);
    }
  }

  const input: GraphViewInput = {
    acceptedFacts,
    rejectedFacts: graph.facts(projectId, "rejected"),
    blockedFacts: graph.facts(projectId, "blocked"),
    candidateFacts: graph.facts(projectId, "candidate"),
    openIntents: graph.intents(projectId, "open"),
    claimedIntents: graph.intents(projectId, "claimed"),
    chainedIntents: graph.intents(projectId, "chained"),
    progress: viewOptions.includeProgress ? graph.progress(projectId) : undefined,
    enrichedContext: options.enrichedContext,
    recentVerdicts: options.recentVerdicts,
    hints: options.hints?.map((h) => ({
      id: h.id, content: h.content, creator: h.creator,
      kind: h.kind, targetIntentId: h.targetIntentId,
    })),
  };

  return renderGraphView(input, viewOptions);
}

function collectRootFactIds(options: BuildContextOptions): string[] {
  const ids = new Set<string>();
  if (options.intent) {
    for (const id of options.intent.parentFactIds) ids.add(id);
  }
  if (options.candidate?.parentIntentId) {
    const intent = options.graph.getIntent(options.projectId, options.candidate.parentIntentId);
    if (intent) {
      for (const id of intent.parentFactIds) ids.add(id);
    }
  }
  if (options.enrichedContext) {
    for (const f of options.enrichedContext) ids.add(f.id);
  }
  return [...ids];
}

function filterRelevantFacts(
  graph: Graph,
  projectId: ProjectId,
  allFacts: Fact[],
  rootFactIds: string[],
  maxHops: number,
): Fact[] {
  const relevant = new Set(rootFactIds);
  const links = graph.links(projectId);

  for (let hop = 0; hop < maxHops; hop++) {
    const frontier = [...relevant];
    for (const link of links) {
      if (frontier.includes(link.fromFactId) && !relevant.has(link.toFactId)) {
        relevant.add(link.toFactId);
      }
      if (frontier.includes(link.toFactId) && !relevant.has(link.fromFactId)) {
        relevant.add(link.fromFactId);
      }
    }
  }

  const filtered = allFacts.filter((f) => relevant.has(f.id));
  if (filtered.length < allFacts.length) return filtered;

  const recent = allFacts.slice(-5);
  const seen = new Set(filtered.map((f) => f.id));
  for (const f of recent) {
    if (!seen.has(f.id)) filtered.push(f);
  }
  return filtered;
}

/**
 * Estimate whether the rendered context is "full" (approaching token limits).
 * The metacog supervisor uses this to decide whether to rotate the run when
 * `rotateOnContextFull` is enabled.
 */
export function estimateContextTokens(text: string): number {
  // Rough heuristic: ~4 chars per token for mixed prose/code.
  return Math.ceil(text.length / 4);
}

export function isContextNearFull(text: string, threshold = 8000): boolean {
  return estimateContextTokens(text) >= threshold;
}
