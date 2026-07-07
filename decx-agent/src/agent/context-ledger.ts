/**
 * ContextLedger — tracks what each (project, profile) worker session has
 * already seen, enabling delta-only prompts.
 *
 * Without this, every worker call re-sends the entire graph state. With it,
 * the SubagentRunner computes the delta (new facts, new verdicts, changed
 * intents) and sends only what changed since the last call — typically a 90%
 * token reduction on steady-state steps.
 *
 * The ledger is keyed by (projectId, profileId). Each entry records the set of
 * fact IDs, intent IDs, verdict signatures, and a sequence number representing
 * the graph state at last sync. On the next call, the runner asks the ledger
 * "what's new since last sync?" and builds a compact delta block.
 *
 * If the delta exceeds 30% of the full context size, the runner falls back to
 * a full sync (and resets the ledger).
 */

import type { Fact, Intent, ProjectId, Verdict } from "./types.js";
import type { Graph } from "../graph/graph.js";

export interface LedgerEntry {
  factIds: Set<string>;
  intentIds: Set<string>;
  verdictSigs: Set<string>;
  rejectedFactIds: Set<string>;
  lastSyncStep: number;
}

export interface DeltaResult {
  isDelta: boolean;
  deltaBlock: string;
  newFactIds: string[];
  newRejectedFactIds: string[];
  newIntentIds: string[];
  newVerdicts: Array<{ factId: string; verdict: Verdict; intentId?: string }>;
}

export class ContextLedger {
  private entries = new Map<string, LedgerEntry>();

  private key(projectId: ProjectId, profileId: string): string {
    return `${projectId}::${profileId}`;
  }

  get(projectId: ProjectId, profileId: string): LedgerEntry | undefined {
    return this.entries.get(this.key(projectId, profileId));
  }

  computeDelta(
    projectId: ProjectId,
    profileId: string,
    graph: Graph,
    recentVerdicts: Array<{ factId: string; verdict: Verdict; intentId?: string }>,
    deltaThreshold = 0.3,
  ): DeltaResult {
    const entry = this.get(projectId, profileId);
    const acceptedFacts = graph.facts(projectId, "accepted");
    const rejectedFacts = graph.facts(projectId, "rejected");
    const allIntents = graph.intents(projectId);

    if (!entry) {
      return this.fullResult(acceptedFacts, rejectedFacts, allIntents, recentVerdicts);
    }

    const newAccepted = acceptedFacts.filter((f) => !entry.factIds.has(f.id));
    const newRejected = rejectedFacts.filter((f) => !entry.rejectedFactIds.has(f.id));
    const newIntents = allIntents.filter((i) => !entry.intentIds.has(i.id));
    const newVerdicts = recentVerdicts.filter((v) => {
      const sig = verdictSig(v);
      return !entry.verdictSigs.has(sig);
    });

    const totalItems = acceptedFacts.length + rejectedFacts.length + allIntents.length;
    const deltaItems = newAccepted.length + newRejected.length + newIntents.length;

    if (totalItems > 0 && deltaItems / totalItems > deltaThreshold) {
      return this.fullResult(acceptedFacts, rejectedFacts, allIntents, recentVerdicts);
    }

    if (deltaItems === 0 && newVerdicts.length === 0) {
      return {
        isDelta: true,
        deltaBlock: "No changes since last call.",
        newFactIds: [],
        newRejectedFactIds: [],
        newIntentIds: [],
        newVerdicts: [],
      };
    }

    const lines: string[] = ["## Delta (since last call)"];
    if (newAccepted.length > 0) {
      lines.push("### New accepted facts:");
      for (const f of newAccepted) lines.push(`- ${f.id}: ${f.description}`);
    }
    if (newRejected.length > 0) {
      lines.push("### Newly rejected (dead-ends):");
      for (const f of newRejected) lines.push(`- ${f.id}: ${f.description}`);
    }
    if (newIntents.length > 0) {
      lines.push("### New/changed intents:");
      for (const i of newIntents) lines.push(`- [${i.status}] ${i.id}: ${i.description}`);
    }
    if (newVerdicts.length > 0) {
      lines.push("### New verdicts:");
      for (const v of newVerdicts) lines.push(`- ${v.factId}: ${v.verdict.decision} — ${v.verdict.reason}`);
    }

    return {
      isDelta: true,
      deltaBlock: lines.join("\n"),
      newFactIds: newAccepted.map((f) => f.id),
      newRejectedFactIds: newRejected.map((f) => f.id),
      newIntentIds: newIntents.map((i) => i.id),
      newVerdicts,
    };
  }

  sync(
    projectId: ProjectId,
    profileId: string,
    graph: Graph,
    recentVerdicts: Array<{ factId: string; verdict: Verdict; intentId?: string }>,
    progress: { stepsExecuted: number },
  ): void {
    const acceptedFacts = graph.facts(projectId, "accepted");
    const rejectedFacts = graph.facts(projectId, "rejected");
    const allIntents = graph.intents(projectId);

    const entry: LedgerEntry = {
      factIds: new Set(acceptedFacts.map((f) => f.id)),
      rejectedFactIds: new Set(rejectedFacts.map((f) => f.id)),
      intentIds: new Set(allIntents.map((i) => i.id)),
      verdictSigs: new Set(recentVerdicts.map((v) => verdictSig(v))),
      lastSyncStep: progress.stepsExecuted,
    };
    this.entries.set(this.key(projectId, profileId), entry);
  }

  reset(projectId: ProjectId, profileId: string): void {
    this.entries.delete(this.key(projectId, profileId));
  }

  resetProject(projectId: ProjectId): void {
    const prefix = `${projectId}::`;
    for (const k of this.entries.keys()) {
      if (k.startsWith(prefix)) this.entries.delete(k);
    }
  }

  private fullResult(
    acceptedFacts: Fact[],
    rejectedFacts: Fact[],
    allIntents: Intent[],
    recentVerdicts: Array<{ factId: string; verdict: Verdict; intentId?: string }>,
  ): DeltaResult {
    return {
      isDelta: false,
      deltaBlock: "",
      newFactIds: acceptedFacts.map((f) => f.id),
      newRejectedFactIds: rejectedFacts.map((f) => f.id),
      newIntentIds: allIntents.map((i) => i.id),
      newVerdicts: recentVerdicts,
    };
  }
}

function verdictSig(v: { factId: string; verdict: Verdict }): string {
  return `${v.factId}:${v.verdict.decision}`;
}
