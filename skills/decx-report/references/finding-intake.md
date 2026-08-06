# Report Finding Intake

Field names follow the Finding Writeup contract in `decx-vulnhunt` (`skills/decx-vulnhunt/SKILL.md`).

1. Read finalized finding writeups.
2. Re-verify each finding's entry→impact path against current code.
3. Build one issue model per finding.

## Finding ID

`id` is `F<n>`, assigned sequentially by decx-vulnhunt during analysis. The report reuses it verbatim and uses it as the HTML anchor.

## Issue Model Fields

Contract fields (from the decx-vulnhunt Finding Writeup):

- `id`
- `title`
- `target`
- `entrypoint`
- `trigger`
- `path` — traced steps with concrete evidence per step:
  - `reachability`
  - `control`
  - `guard`
  - `sink`
- `impact`
- `rating`
- `evidence`

Report-added fields:

- `remediation` — fix advice for the finding
- `compositionVerdict` / `compositionDetail` — two-state composition analysis (see `report-format.md`)
- presentation fields derived from the above, e.g. `anchor` (= `id`), `riskClass` (from `rating`), short titles and per-step details

Do not render a finding whose required contract fields are missing.
