---
name: decx-analysis-core
description: Core DECX analysis graph protocol. Use as an internal protocol for domain skills that need Fact/Intent/Hint DAG orchestration, planner/generator/evaluator role separation, or reusable analysis graph commands. Do not use directly for APP/framework/cloud/reverse domain conclusions.
---

# DECX Analysis Core

## Routing Gate

Use only as shared graph/orchestration core for DECX domain analysis skills. Do not use directly for APP/framework/cloud/reverse conclusions.

## Boundary

Core is only the analysis DAG kernel:

- build and extend a traceable DAG;
- query paths, ancestors, descendants, and chains;
- aggregate per-Fact confidence and check evidence gates;
- enforce Planner / Generator / Evaluator write boundaries;
- provide atomic intent claims for parallel work.

Core does **not** define APP/framework/cloud/reverse semantics, fact kinds, risk, severity, report policy, tool routing, confidence bands, or promotion thresholds — those belong to the domain skill.

## Session Contract

One analysis session owns one graph directory:

```text
.decx-analysis/<session>/decx-analysis.db
```

`--session` is metadata inside that database, not a selector inside a shared DB.

## Primitives

Exactly three graph nodes exist:

| Node | Meaning | Writer |
|---|---|---|
| Fact | accepted evidence (carries a 0..1 `confidence`) | Evaluator, or Planner for explicit root facts |
| Intent | concrete analysis task | Planner |
| Hint | human-authored guidance | Planner records human input |

Links are provenance only. Chains are derived from links, never stored as independent truth.

A **Hypothesis** is not a fourth node — it is a Fact with `--kind hypothesis`, recording a speculative risk path that is not yet fully proven. See `references/graph-protocol.md`.

## Required Flow

1. Planner initializes root Fact/Intent nodes.
2. Planner records human Hint nodes when supplied.
3. Planner creates Intents from existing Fact/Intent/Hint nodes.
4. Generator claims one Intent, executes it, and returns temp facts + evidence artifacts.
5. Generator may chain to another Generator only inside the same Intent.
6. Evaluator checks temp facts, writes accepted Facts, then closes/fails the Intent.
7. Planner reads returned node IDs / graph queries and continues planning.

Planner must not accept temp facts. Generator must not write DAG truth. Evaluator must not explore new directions.

## DAG Invariants

- Every non-root node is reachable from a root.
- Every link points to an existing Fact, Intent, or Hint.
- New links must not introduce cycles.
- Fact and Hint nodes are immutable after creation.
- Accepted Fact write + `Intent -> Fact` link is one atomic operation.

## Minimal Commands

```bash
node skills/decx-analysis-core/scripts/decx-graph.mjs init <graph-dir> --session <name> --kind <domain>
node skills/decx-analysis-core/scripts/decx-graph.mjs fact <graph-dir> --root --kind target --body "<root fact>" --evidence <path-or-note>
node skills/decx-analysis-core/scripts/decx-graph.mjs intent <graph-dir> --root --goal "<initial task>" --phase surface [--priority <n>]
node skills/decx-analysis-core/scripts/decx-graph.mjs intent <graph-dir> --from <node,...> --goal "<task>" --phase <phase> [--priority <n>]
node skills/decx-analysis-core/scripts/decx-graph.mjs start <graph-dir> <intentId> --by <generator-id> [--lease-ms 1800000]
node skills/decx-analysis-core/scripts/decx-graph.mjs renew <graph-dir> <intentId> --by <generator-id> [--lease-ms 1800000]
node skills/decx-analysis-core/scripts/decx-graph.mjs fact <graph-dir> --from <intentId> --kind <type> --body "<accepted evidence>" --evidence <path> --confidence <0..1>
node skills/decx-analysis-core/scripts/decx-graph.mjs link <graph-dir> --from <fact> --to <fact> --kind derives
node skills/decx-analysis-core/scripts/decx-graph.mjs hint <graph-dir> --from <node> --body "<human guidance>" --author human
node skills/decx-analysis-core/scripts/decx-graph.mjs solve <graph-dir> <intentId> --status solved|failed|cancelled [--fail "<reason>" | --reason "<reason>"]
node skills/decx-analysis-core/scripts/decx-graph.mjs confidence <graph-dir> --from <node>
node skills/decx-analysis-core/scripts/decx-graph.mjs gate <graph-dir> --from <entry-fact> --kinds <a,b,c> [--threshold <0..1>]
node skills/decx-analysis-core/scripts/decx-graph.mjs chains <graph-dir>
node skills/decx-analysis-core/scripts/decx-graph.mjs check <graph-dir>
node skills/decx-analysis-core/scripts/decx-graph.mjs export <graph-dir>
```

`start` atomically claims an `open` intent or reclaims a `running` intent whose lease expired. `renew` keeps a long-running claim alive. `--by` has a `--worker` alias and `--lease-ms` has a `--leaseMs` alias. `intent --priority <n>` orders intents in queries (higher first; default `0`). `solve --status failed` requires `--fail "<reason>"` or `--reason "<reason>"`; `--fail` alone implies `failed`.

`fact --confidence` sets per-Fact evidence strength (0..1). `confidence` aggregates it forward (min over a chain, max over a merge). `gate` checks which required Fact kinds are present on the path from an entry Fact and the path's chain confidence — the machine-checkable form of a domain evidence gate. `chains` lists root-to-leaf paths with each chain's confidence, sorted descending. See `references/graph-protocol.md` for the confidence model and Hypothesis usage.

## References

- `references/graph-protocol.md` — DAG invariants and node rules.
- `references/role-protocol.md` — role boundaries, leases, generator chaining.
- `references/extension-contract.md` — what domain skills must provide.
- `references/finding-consumer-contract.md` — how downstream skills consume finalized findings.
