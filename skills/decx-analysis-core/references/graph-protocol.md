# DECX Analysis Core Graph Protocol


## Session Boundary

A graph database represents one analysis session. The recommended location is:

```text
.decx-analysis/<session>/decx-analysis.db
```

Do not store multiple independent sessions in one database. Use the session name in `projects.session` for identity and recovery, not as a query selector.

## Primitives

The graph contains only Fact, Intent, and Hint nodes.

- Fact: accepted evidence with provenance.
- Intent: a concrete analysis task created by the planner.
- Hint: human-authored guidance that can influence later intents.

Links are structural provenance between primitives. They are not domain facts.

## Root Nodes

A root node is allowed only when initializing or manually steering the graph:

- root Intent: initial collection or setup task;
- root Fact: externally supplied accepted starting fact;
- root Hint: human guidance that applies to the whole graph.

Every non-root node must be reachable from at least one root.

## Fact Rules

- A normal Fact must be produced by exactly one accepted intent path.
- A Fact must include an evidence path or explicit source in the body.
- A Fact's `kind` is free-form and belongs to the domain skill.
- Core must not validate APP/framework/cloud/reverse fact kinds.


## Fact Granularity

A Fact should be the smallest re-checkable semantic assertion useful for the current analysis.

Avoid:
- one source line per Fact;
- one whole exploit/reverse-analysis conclusion per Fact;
- facts that combine entry, control, guard, sink, and impact at once.

Prefer:
- one accepted reachability assertion;
- one accepted controllability assertion;
- one accepted guard/identity assertion;
- one accepted transformation or semantic-reversal assertion.

## Intent Rules

- An Intent must be derived from existing Fact, Intent, or Hint unless it is root.
- Planner creates intents.
- Generator executes one intent.
- Evaluator acceptance links accepted Facts from that intent.
- Intent lifecycle is `open -> running -> solved | failed | cancelled`.
- `intent --priority <n>` sets an ordering weight; queries list higher-priority intents first (default `0`).
- `solve --status failed` requires a reason via `--fail "<text>"` or `--reason "<text>"`; `--fail` alone also implies `failed`. `solved` and `cancelled` need no reason.

## Hint Rules

- Hint is human-authored guidance.
- Hint is not evidence.
- Hint may point to a Fact, Intent, or the whole graph.
- Planner may create later intents from Hint.

## DAG Rules

- All links must point to existing nodes.
- Links are append-only.
- Links must not introduce cycles.
- Chains must be derived from graph links.
- Graph validation must check dangling links, cycles, and unreachable non-root nodes.

## Confidence Semantics

Every Fact carries a `confidence` score in `[0.0, 1.0]` (default `1.0`). It expresses *how firmly the evidence backs this Fact*, not how severe it is. Intents and Hints always contribute `1.0` to confidence math.

- `1.0` — proven from source / artifact that can be re-read (decompiled line, manifest entry, trace output).
- `0.5 – 0.7` — inferred across a boundary that could not be fully traced (cross-process, cross-version, dynamic dispatch resolved by assumption).
- `0.2 – 0.4` — behavioural speculation with no static proof (observed pattern shape only, unconfirmed reachability).

Exact band boundaries are defined by the domain skill (see `extension-contract.md`); core only stores and aggregates the number.

### Aggregation

- **Chain confidence** = `min(confidence)` over the Facts on one derived chain (weakest-link rule). A speculation-only chain is dominated by its least-proven step — this is what precision-first vuln hunting wants.
- **Merge** = `max(chain confidence)` over multiple chains reaching the same node (the strongest supporting evidence wins).
- `confidence <graph-dir> --from <node>` walks the forward DAG and reports the aggregated confidence reaching each descendant.
- `chains <graph-dir>` reports each root-to-leaf path with its `chain_confidence`, sorted descending so the best-evidenced chains surface first.

### Linking Facts into Chains

A Fact produced by an Intent is provenance-linked to that Intent (`produces`), but Facts are **not** automatically chained to each other. To build an evidence chain (e.g. `entrypoint → reachability → control → guard → sink → impact`), link the Facts explicitly:

```bash
node skills/decx-analysis-core/scripts/decx-graph.mjs link <graph-dir> --from f001 --to f002 --kind derives
```

`chains`, `confidence`, and `gate` all follow these Fact-to-Fact links.

## Hypothesis

A Hypothesis is not a new node type — it is a Fact with `--kind hypothesis`. It records a *speculative risk path*: a suspected exploitable chain that has not yet been fully proven. This is the vuln-hunting analogue of a search target, adapted to the reality that vuln hunting has no provable flag — only risk that is more or less supported by evidence.

- Created by the Planner when a risk path is suspected but evidence is incomplete. Body names the suspected entry, the speculative sink, and what is missing.
- Initial confidence is low (typically `0.2 – 0.4`).
- Linked to its supporting evidence Facts via `link --kind supports` (so `gate` and `chains` can evaluate it).
- Promoted to a formal `app-finding` / `framework-finding` only when the evidence gate becomes `complete` and `chain_confidence` meets the domain threshold. Until then it stays as a low-confidence record — **not reported as a finding, but not lost either** (the "unresolved candidate" of the risk-rating gate).

```bash
node skills/decx-analysis-core/scripts/decx-graph.mjs fact <graph-dir> --from <intentId> --kind hypothesis --body "suspected X via Y; missing Z proof" --evidence <note> --confidence 0.3
node skills/decx-analysis-core/scripts/decx-graph.mjs link <graph-dir> --from <entry-fact> --to <hypothesis-fact> --kind supports
```
