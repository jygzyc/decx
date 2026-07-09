# AGENTS.md

Guidance for DECX skills.

- A DECX skill must provide at least one of: precise routing, DECX-private workflow/artifact knowledge, or hard negative constraints.
- Every `SKILL.md` must keep a precise `description` and a top-level `Routing Gate` that says when to use it and when not to use it.
- Do not add generic security, Android, reporting, coding, or testing advice that a base model already knows.
- Do not make wrapper skills that only tell the agent to read another file.
- Keep knowledge references under `references/`; load only the specific reference needed for the observed signal.
- Put critical constraints near the top or in a dedicated `Rules` / `Constraints` section.
- Prefer routing matrices, artifact contracts, command contracts, and banned patterns over broad best-practice prose.

## Reference Architecture

### Layers

| Layer | Purpose | Load when |
|---|---|---|
| `index.md` | Routing matrix: composite chains, single-pattern routing, load order | Always first |
| `patterns/` | Vulnerability shape: core concept, sources, sinks, guards, rating, trace commands, example shapes | Specific signal matched |
| `risk-rating.md` | Exploitability gate, severity levels, adjustment factors, confidence mapping | Before promoting a candidate |

### Single Source of Truth

- **Chain pivot routing**: `index.md` only. Do not duplicate in pattern files.
- **Rating authority**: `risk-rating.md` only. Patterns convey impact scope in the `## Analyze` `impact` field; they do not have a standalone `## Rating` section.
- **Evidence gate**: the core `gate` command is the only promotion gate check; do not re-derive completeness from prose.
- **False-positive and sibling-card loading rules**: SKILL.md `Constraints` + `index.md` Load Order. Do not repeat in pattern files.

### Pattern Template

Every pattern file must follow this structure:

```
# Pattern: <Name>

## Match
## Analyze   (entry / control / sink / guard / impact as dash-prefixed items)
## Reject
## Codes     (suspicious code, edge cases; no trivially safe examples)
```

- `## Match` — observable routing signals and entry-specific behavioral notes (API level quirks, non-obvious defaults). Not explanatory text.
- `## Analyze` — structured as `- entry:`, `- control:`, `- sink:`, `- guard:`, `- impact:` dash items. Guard covers both pass-through guards and bypass conditions. Impact covers rating-relevant scope.
- `## Reject` — negative constraints: when to stop analyzing.
- `## Codes` — concrete suspicious code shapes and edge case examples. No trivially obvious "safe pattern" code blocks.
- No `## Related Problems` section — chain pivots live in `index.md`.
- No `## Rating` section — rating authority is `risk-rating.md` only; patterns convey impact scope in `## Analyze`'s `impact` field.
- No `## Trace Commands` section — DECX CLI commands belong in the parent SKILL.md, not in pattern references.

### Framework Pattern Additions

Framework patterns add one section before `## Reject`:

```
## Required Trace Evidence
Reachability, Controllability, Sink, Missing guard, Visible impact
```

Framework guards must include explicit Binder boundary constraints (e.g., caller identity bound before privileged operation, target user bound via INTERACT_ACROSS_USERS before asUser call).

## Skill Inventory

| Skill | Scope |
|---|---|
| `decx-cli` | DECX CLI command usage. Independent, no cross-skill routing. |
| `decx-analysis-core` | Shared Fact/Intent/Hint DAG protocol, confidence propagation, evidence-gate checks, and planner/generator/evaluator orchestration for DECX analysis skills. |
| `decx-app-vulnhunt` | APK app-layer vulnerability hunting. Uses `decx-analysis-core`; keeps APP routing and evidence gates locally. |
| `decx-framework-vulnhunt` | Framework/Binder vulnerability hunting. Uses `decx-analysis-core`; keeps framework routing and evidence gates locally. |
| `decx-report` | Report generation from finalized finding Facts in the shared DAG. |
| `decx-poc` | PoC construction from one finalized finding Fact. |
