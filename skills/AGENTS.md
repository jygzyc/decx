# AGENTS.md

Guidance for DECX skills.

- A DECX skill must provide at least one of: precise routing, DECX-private workflow/artifact knowledge, or hard negative constraints.
- Every `SKILL.md` must keep a precise `description` and a top-level `Routing Gate` that says when to use it and when not to use it.
- Do not add generic security, Android, reporting, coding, or testing advice that a base model already knows.
- Do not make wrapper skills that only tell the agent to read another file.
- Keep knowledge references under `references/`; load only the specific reference needed for the observed signal.
- Put critical constraints near the top or in a dedicated `Rules` / `Constraints` section.
- Prefer routing matrices, artifact contracts, command contracts, and banned patterns over broad best-practice prose.

## Cross-Skill Contract

- The finding writeup field contract lives in `decx-vulnhunt` `SKILL.md` (`## Finding Writeup`) and is the single source of truth. `decx-report` and `decx-poc` consume it by reference; do not redefine field names downstream.

## decx-vulnhunt Reference Architecture

### Layers

| Layer | Purpose | Load when |
|---|---|---|
| `<track>-chains.md` | Routing matrix: composite chains, single-pattern routing | Track chosen, always first |
| `patterns/<track>_*.md` | Pattern cards: routing signals, non-obvious quirks, reject rules | Specific signal matched |
| `risk-rating.md` | Exploitability gate, severity levels, adjustment factors | Before promoting a candidate |

### Single Source of Truth

- **Chain pivot routing**: `<track>-chains.md` only. Do not duplicate in pattern cards.
- **Rating authority**: `risk-rating.md` only. Pattern cards convey impact scope in their content; they have no rating sections.
- **False-positive and sibling-card loading rules**: `decx-vulnhunt` `SKILL.md` only. Do not repeat in pattern files.

### Pattern Card Format

Every pattern card is a compact card with YAML frontmatter:

```
---
name: <name>
track: app|framework
---

# <name>

## Match
## Non-obvious     (or ## Direction hints for open-ended surfaces)
## Reject
```

- `## Match` — observable routing signals and entry-specific behavioral notes (API level quirks, non-obvious defaults). Not explanatory text.
- `## Non-obvious` — version defaults, parser quirks, and API/Binder/identity/permission behaviors a base model does not know. One dash item per fact.
- `## Direction hints` — only for open-ended surfaces where no closed-form signals exist (e.g. native surface, cross-app channels, validation gap).
- `## Reject` — negative constraints: when to stop analyzing.
- A card must add at least one of: a routing signal, a non-obvious quirk or version default, or a closed-form constraint that prevents false positives. If it only repeats generic Android security knowledge, cut it.
- Knowledge shared across cards lives in the card it belongs to most; other cards use a single-line `See [[<card>]]` cross-reference.
- No `## Rating` section — rating authority is `risk-rating.md` only.
- No `## Trace Commands` section — DECX CLI commands belong in the parent SKILL.md or the `decx-cli` skill, not in pattern cards.

## Skill Inventory

| Skill | Scope |
|---|---|
| `decx-cli` | DECX CLI command usage. Independent, no cross-skill routing. |
| `decx-vulnhunt` | Android vulnerability hunting method (App + Framework tracks): surface collection, pattern routing, evidence gates, risk rating, finding writeup contract. |
| `decx-report` | Report generation from finalized finding writeups. |
| `decx-poc` | PoC construction from one finalized finding writeup. |
