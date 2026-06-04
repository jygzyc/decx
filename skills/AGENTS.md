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
| `index.md` | Routing matrix: composite chains, single-pattern routing, load order, casebook index | Always first |
| `overviews/` | Component analysis flow, promotion signals, false positive guide | Entrypoint context matters |
| `patterns/` | Vulnerability shape: core concept, sources, sinks, guards, rating, trace commands, example shapes | Specific signal matched |
| `casebooks/` | Abstract exploit-chain shapes from public cases | Comparable chain shapes needed |
| `risk-rating.md` | Exploitability gate, severity levels, adjustment factors | Before promoting a candidate |

### Single Source of Truth

- **Chain pivot routing**: `index.md` only. Do not duplicate in overviews or pattern files.
- **Rating authority**: `risk-rating.md` only. Patterns include pattern-specific rating sections that describe typical impact scope.
- **False-positive and sibling-card loading rules**: SKILL.md `Constraints` + `index.md` Load Order. Do not repeat in pattern files.

### Pattern Template

Every pattern file must follow this structure:

```
# Pattern: <Name>

## When To Use
## Core Concept
**Sources** / **Sinks**
## Guards & Rejection  (or Required Trace Evidence for framework patterns)
## Rating
## Trace Commands
## Example Shapes  (Suspicious / Safe)
Report guidance -- Use: "<good>". Avoid: "<bad>".
```

- No `## Related Problems` section — chain pivots live in `index.md`.
- Sources and Sinks use `**Sources**` / `**Sinks**` bold headings, not `##` subheadings.
- Guard and rejection rules must be combined in one `## Guards & Rejection` section.
- Every pattern must include `## Example Shapes` with concrete Suspicious and Safe chain diagrams.
- Report guidance uses the full form: `Report guidance -- Use: "..." Avoid: "..."`.

### Framework Pattern Additions

Framework patterns add one section before `## Guards & Rejection`:

```
## Required Trace Evidence
Reachability, Controllability, Sink, Missing guard, Visible impact
```

Framework guards must include explicit Binder boundary constraints (e.g., caller identity bound before privileged operation, target user bound via INTERACT_ACROSS_USERS before asUser call).

### Casebook Format

Every case follows this structure:

```
## Case: <Name>
### Abstract Shape   (text diagram)
### Key Mistake
### Why It Was Exploitable
### Generalized Detection Rule
### Related           (pattern cross-references)
```

## Skill Inventory

| Skill | Scope |
|---|---|
| `decx-cli` | DECX CLI command usage. Independent, no cross-skill routing. |
| `decx-app-vulnhunt` | APK app-layer vulnerability hunting. Delegates chain traces to `decx-subagent`. |
| `decx-framework-vulnhunt` | Framework/Binder vulnerability hunting. Delegates chain traces to `decx-subagent`. |
| `decx-subagent` | Delegated subagent for chain traces, sink checks, guard checks, and PoC sink re-verification. Invoked by parent skills only. |
| `decx-report` | Report generation from finalized `r_*.xml` artifacts. |
| `decx-poc` | PoC app construction from one finalized finding. Delegates re-verification to `decx-subagent`. |
