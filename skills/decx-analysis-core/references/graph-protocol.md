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
