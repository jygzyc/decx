# Finding Consumer Contract

Use when a downstream skill consumes a finalized finding from the DAG.

## Entry

Consume only accepted Facts whose kind is `finding`, `app-finding`, or `framework-finding`.

A finding Fact must point to evidence that identifies:

- finding id/title;
- entry fact id;
- impact fact id;
- required path facts: entry, reachability, control, guard/identity, sink, impact;
- target/session reference.

## Re-check

Before producing output:

```bash
node skills/decx-analysis-core/scripts/decx-graph.mjs path <graph-dir> --from <entry_fact> --to <impact_fact>
node skills/decx-analysis-core/scripts/decx-graph.mjs ancestors <graph-dir> --from <impact_fact>
node skills/decx-analysis-core/scripts/decx-graph.mjs export <graph-dir>
```

Stop if the path is missing, required facts are absent, or evidence artifacts cannot be re-read.

## Consumer Rules

- Do not create or modify Facts, Intents, or Hints.
- Do not promote candidates.
- Do not infer missing guard, sink, impact, or trigger values.
- Report blockers instead of filling gaps.
