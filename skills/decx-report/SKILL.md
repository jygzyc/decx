---
name: decx-report
description: Generate DECX reports from finalized DAG finding facts. Use after decx-app-vulnhunt or decx-framework-vulnhunt has produced accepted finding facts.
---

# DECX Report

## Routing Gate

Use only when the user asks for a report from finalized DECX finding facts. Residual open intents may appear only as a report section, not as findings.

Do not use for vulnerability discovery, chain tracing, PoC construction, or generic report templates. If no finalized finding fact exists, route back to the relevant vulnhunt skill.

## Workflow

1. Load `skills/decx-analysis-core/references/finding-consumer-contract.md`.
2. Load `references/finding-intake.md`.
3. Re-check each finding path in the DAG.
4. Build one report issue model per finding.
5. Load `references/report-structure.md` and `references/composition-section.md`.
6. Render all default outputs: `report.html`, `report.zh.md`, and `report.en.md`. Load each template only at render time.

## Commands

```bash
node skills/decx-analysis-core/scripts/decx-graph.mjs facts <graph-dir> --kind finding
node skills/decx-analysis-core/scripts/decx-graph.mjs facts <graph-dir> --kind app-finding
node skills/decx-analysis-core/scripts/decx-graph.mjs facts <graph-dir> --kind framework-finding
node skills/decx-analysis-core/scripts/decx-graph.mjs path <graph-dir> --from <entry_fact> --to <impact_fact>
node skills/decx-analysis-core/scripts/decx-graph.mjs ancestors <graph-dir> --from <impact_fact>
node skills/decx-analysis-core/scripts/decx-graph.mjs intents <graph-dir> --status open
node skills/decx-analysis-core/scripts/decx-graph.mjs export <graph-dir>
```

## Rules

| Rule | Rationale |
|---|---|
| Consume only accepted finding facts | report is downstream output |
| Re-check DAG path before rendering | prevents stale findings |
| Keep open intents in residual section | open intents are not findings |
| Do not invent missing guard, sink, impact, trigger, or composition | evidence-bound output |
| Do not write `runtime-validated` or `poc-validated` | report mirrors DAG state |
| Generate HTML + Chinese Markdown + English Markdown by default | complete default output |
| All formats must use the same finding IDs and evidence model | avoids divergence |

## References

- `skills/decx-analysis-core/references/finding-consumer-contract.md`
- `references/finding-intake.md`
- `references/report-structure.md`
- `references/composition-section.md`
- `assets/report-template-html.html`
- `assets/report-template-zh.md`
- `assets/report-template-en.md`
