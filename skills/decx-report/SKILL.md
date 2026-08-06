---
name: decx-report
description: Generate DECX reports from finalized finding writeups. Use after decx-vulnhunt has produced proven findings.
---

# DECX Report

## Routing Gate

Use only when the user asks for a report from finalized DECX findings. If no finalized finding exists, route back to decx-vulnhunt.

Do not use for vulnerability discovery, chain tracing, PoC construction, or generic report templates.

## Workflow

1. Load `references/finding-intake.md`.
2. Read each finalized finding writeup and re-verify its entry→impact path.
3. Build one report issue model per finding.
4. Load `references/report-format.md`.
5. Render all default outputs: `report.html`, `report.zh.md`, and `report.en.md`. Load each template only at render time.

## Rules

| Rule | Rationale |
|---|---|
| Report only findings with a complete proven path | report is downstream output |
| Do not invent missing fields or assert `runtime-validated` / `poc-validated` | evidence-bound output; report mirrors analysis state |
| Generate HTML + Chinese Markdown + English Markdown by default | complete default output |
| All formats must use the same finding IDs and evidence model | avoids divergence |

## References

- `references/finding-intake.md`
- `references/report-format.md`
- `assets/report-template-html.html`
- `assets/report-template-zh.md`
- `assets/report-template-en.md`
