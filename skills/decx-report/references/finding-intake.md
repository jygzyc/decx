# Report Finding Intake

Field names follow the Finding Writeup contract in the `decx-vulnhunt` skill (its `SKILL.md`, section `## Finding Writeup`).

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
- `compositionVerdict` / `compositionDetail` — the two-state composition analysis the
  Markdown templates render (see `report-format.md`)
- the HTML branch fields the same verdict needs: no composition → `compositionReason`,
  `evaluatedCombinations` (the relations actually evaluated) and `compositionBlocker`;
  composed → `comparisonRows` (standalone vs composed: `路径` / `攻击步骤数` / `是否需要暴破`
  / `最终获取`), a numbered `fullAttackSteps` list, and `standaloneImpact` /
  `composedImpact` / `impactDelta` (what changes when the chain composes — additional to
  the writeup's own `impact`)
- presentation fields derived from the above, e.g. `anchor` (= `id`), `riskClass` (from `rating`), short titles and per-step details

## Rules

- Reuse `id`, `rating` and `impact` verbatim: the report never re-rates, promotes or
  downgrades a path, and a presentation field never replaces an analysis field.
- One issue model per finding; composition is decided inside that finding's composition
  section, never by merging finding cards.
- A path that fails re-verification is not reported at all.
- Do not render a finding whose required contract fields are missing — no placeholder and
  no partial issue card.
