# AGENTS.md

Guidance for DECX skills.

- A DECX skill must provide at least one of: precise routing, DECX-private workflow/artifact knowledge, or hard negative constraints.
- Skills are loaded by the agent harness directly from this repository — point the harness at `skills/`. There is no install step: edit the files here in place.
- Do not reference repository-relative paths (`skills/decx-*/...`) in a skill: an installed skill is read from its own directory, so use paths relative to the skill directory.
- Every `SKILL.md` must keep a precise `description` and a top-level `Routing Gate` that says when to use it and when not to use it.
- Do not add generic security, Android, reporting, coding, or testing advice that a base model already knows.
- Do not make wrapper skills that only tell the agent to read another file.
- Keep knowledge references under `references/`; load only the specific reference needed for the observed signal.
- Put critical constraints near the top or in a dedicated `Rules` / `Constraints` section.
- Prefer routing matrices, artifact contracts, command contracts, and banned patterns over broad best-practice prose.

## Cross-Skill Contract

- The finding writeup field contract lives in `decx-vulnhunt` `SKILL.md` (`## Finding Writeup`) and is the single source of truth. `decx-report` and `decx-poc` consume it by reference; do not redefine field names downstream.

## Reference Architecture

Every skill keeps its knowledge in `references/`; nothing in a skill body may depend
on the repository layout.

### Layers

| Layer | Purpose | Load when |
|---|---|---|
| `<track>-chains.md` | Routing matrix: composite chains, single-pattern routing | Track chosen, always first |
| `references/patterns/<track>-<summary>.md` | Pattern cards (runtime tripwire copy; the wiki page is the maintenance record) | Specific signal matched |
| `<platform>-poc-*.md` (`decx-poc`) | PoC harness set for one target: spec, base contract, one file per surface | After the PoC spec is complete |
| `risk-rating.md` | Exploitability gate, severity levels, adjustment factors | Before promoting a candidate |

### Reference naming

- A reference that only makes sense for one target carries the target prefix:
  `android-app-chains.md`, `android-framework-chains.md`, `native-chains.md`,
  `android-poc-base.md`, `android-poc-activity.md`. A second target adds its own
  `<track>-*.md` beside them (plus its own section in `index.md`), never a rewrite.
- A reference that applies to every target stays unprefixed: `risk-rating.md`,
  `poc-spec.md`, `index.md`, `finding-intake.md`, `report-format.md`.
- Pattern-card mirrors always live in `references/patterns/<track>-<summary>.md`: the file
  name equals the card slug, so the track prefix is already in it.
- A skill mirrors only the cards of the tracks it hunts: `decx-vulnhunt` mirrors
  `android-app-*`, `android-framework-*` and `native-*` (27 cards).

### Single Source of Truth

- **Chain pivot routing**: `<track>-chains.md` only. Do not duplicate in pattern cards.
- **Rating authority**: `risk-rating.md` only. Pattern cards convey impact scope in their content; they have no rating sections.
- **False-positive and sibling-card loading rules**: `decx-vulnhunt` `SKILL.md` only. Do not repeat in pattern files.

### Pattern Card Format

Every pattern card is a compact card with YAML frontmatter:

```
---
name: <summary>
track: <platform>[-<component>]
---

# <summary>

## Match
## Non-obvious
## Reject
```

A card is named `<platform>[-<component>]-<summary>`, and `track` is the leading
platform (plus component where a platform has several) while `name` is the summary — so the file name is always
`<track>-<name>`: `track: android-framework` with `name: clear_identity` gives
`android-framework-clear_identity.md`. Segments are joined with `-`, words inside a
segment with `_`. `platform` is the target platform (`android`, `native`, `decx`),
`component` the surface inside it (`app`, `framework`, `poc`, `tool`, `report`,
`process`), omitted for a single-surface platform, and `summary` the behaviour or rule. Tracks name the *target*, not the
analyzer: a card about driving an analyzer or the manager takes the `decx-` platform
(`android-app-exported_access`), and a second platform's cards sit beside the first
without a rewrite.

- `## Match` — opens with a one-line trigger (<= 140 characters including the period;
  it becomes the index row), then the observable routing signals and entry-specific
  behavioral notes (API level quirks, non-obvious defaults). Not explanatory text.
- `## Non-obvious` — version defaults, parser quirks, and API/Binder/identity/permission behaviors a base model does not know. One dash item per fact. Open-ended surfaces (native surface, cross-app channels, validation gap) use the same section.
- `## Reject` — negative constraints: when to stop analyzing.
- A card must add at least one of: a routing signal, a non-obvious quirk or version default, or a closed-form constraint that prevents false positives. If it only repeats generic Android security knowledge, cut it.
- Knowledge shared across cards lives in the card it belongs to most; other cards use a single-line `See [[<card>]]` cross-reference.
- No `## Rating` section — rating authority is `risk-rating.md` only.
- No `## Trace Commands` section — native tool command lines belong in the parent SKILL.md or the tool's own skill (`decx-droidasc`, `decx-kuna`, `decx-afe`), not in pattern cards.

## Knowledge Layers (decx)

The workspace has three sibling layers at the repository root, following WikiSkill:
`raw/` holds immutable execution records, `wiki/` is the persistent knowledge base,
and `skills/` holds the executable procedures. A skill never needs `wiki/` to run:
the inference agent reads only `SKILL.md` and its `references/`.

- `raw/` — one immutable trace per session: target, exact commands, observations,
  failures and fixes. Written by `decx_trace`; gitignored except `README.md`
  (a reviewed record may be force-added when a proposal cites it).
- `wiki/patterns/<track>-<name>.md` — the pattern pages; identity is the file slug,
  so `android-app-pendingintent` and `android-framework-pendingintent` coexist. Every page keeps the
  `name:` / `track:` frontmatter and the `## Match` / `## Non-obvious` / `## Reject`
  sections.
- `wiki/index.md` — the one catalog, grouped by track, inside the
  `<!-- decx:index:start/end -->` block (`` - `slug` — trigger ``, the trigger being the
  card's `## Match` opener).
- `wiki/logs.md` and `wiki/skill-impact.md` — the two seeded auxiliary files: the
  chronological maintainer log and the proposal ledger. Pattern pages and the index are
  the working set; both auxiliary files stay at their seeded state by default — a
  maintenance pass writes patterns and the index only (a log entry needs `log: true`),
  and the ledger is written only by `decx_propose`. The wiki is never rolled back,
  even when a skill proposal is.
- `track:` is the catalog's cross-project axis and names the *target*, not the analyzer.
  The four tracks are `android-app` / `android-framework` (decx-vulnhunt, over
  DroidASC/AFE), `android-poc` (the Android PoC harness set) and `native` (a native
  binary, Kuna). DECX's own machinery — the manager, report generation, PoC specification
  and the analysis process — is never a track: it lives in the skill that owns it.
  Wiring another analyzer into DECX adds cards under an existing track (or a new
  `<platform>[-<component>]` track) — never a second catalog.

### Bootstrap is not evidence

The current pages were seeded from authored skills and references — **bootstrap
material**, not empirical rollout evidence: no page has a measured rollout score.
Structural checks (`node .pi/extensions/decx/cli.ts check`, index sync,
frontmatter lint) verify maintenance hygiene, not validation performance. The
paper's harness validation split (train/validation/test gating of one proposal) is
not reproduced in this repository, so no page may claim a score it does not have and
no change may be called an improvement without a measured baseline/candidate
comparison on the same split.

### Skill card vs wiki page: deliberate duplication

The wiki page is the maintenance record (evidence, history, proposals); the skill
card under `skills/<skill>/references/patterns/` is the runtime tripwire the agent
loads. The duplication is deliberate: removing one is the trigger to regenerate the
other, and a card edit is mirrored on its page (and vice versa). `PURPOSE.md` next
to each `SKILL.md` is maintenance metadata for `decx_maintain` / `decx_propose` — never read
during execution. It carries only the motivating pattern slugs (paths are workspace-root
relative, e.g. `wiki/patterns/<slug>.md`), the skill's must-keeps and a one-line bootstrap
state; no header boilerplate and no change history.

### Maintenance loop

The trace → pattern → proposal loop runs through the extension's `decx_*` tools — no
skill owns it. The extension counts analysis rounds (7 by default, `checkpoints` in
`.pi/extensions/decx.json`) and steers a `decx_checkpoint` request — goal,
facts, steps, next — so the goal survives compaction and drift is visible. The
ledger is agent state under the pi agent directory, never committed. Execution
produces traces; the maintainer consolidates them into pattern pages and the index
(the log and the ledger stay seeded unless an entry is explicitly recorded); the
proposer turns them into one atomic `SKILL.md` change; the gate accepts or rolls back
the skill while the wiki persists. Gate before committing a knowledge change:
`node .pi/extensions/decx/cli.ts check` (exit 1 on errors; it verifies
frontmatter, section skeleton, index sync and every markdown/wikilink target).

## Skill Inventory

One skill per tool and per analysis surface; session procedure and maintenance are tools,
not skills. The split is deliberate: process skills are target-neutral, analyzer skills are
per tool, so a new target adds rows instead of rewriting either group. Every skill lives
in the repository's `skills/` directory, one directory per skill (`skills/<name>/SKILL.md`).

| Skill | Track / target | Scope |
|---|---|---|
| `decx-init` | any | Initializing DECX: the manager's usage (commands, options, exit codes, environment variables), install/run, DECX_HOME layout, PROVENANCE records, pinned releases, missing runtimes, and the `skills/` + `wiki/` + `raw/` workspace the extension materializes. Never an analysis interface. |
| `decx-vulnhunt` | `android-app`, `android-framework`, `native` | Vulnerability hunting method over every target: surface collection, target routing, evidence gates, risk rating, finding writeup contract. |
| `decx-report` | any | Report generation from finalized finding writeups. |
| `decx-poc` | `android-app`, `android-framework` (harness set) | PoC construction from one finalized finding writeup; a target with no harness reference stops at the PoC spec. |
| `decx-droidasc` | `android-app`, `android-framework` | DroidASC (upstream ASC): DEX analysis and cross-references on APK/JAR containers — identifiers, output and error contracts, the GUI path. |
| `decx-afe` | `android-framework` | AFE: framework collection and preprocessing into the packed jar, plus live device reads. Produces files, never analysis. |
| `decx-kuna` | `native` | Kuna: native binaries and ET_REL objects — functions, decompilation, cross-references, strings, unpacking. |

### Adding a target or analyzer

A new analyzer is one inventory row plus its skill; a new target is a track.

1. Add the tool as a subproject `subprojects/decx-<tool>/`: the checkout it installs (`source/` for a vendored tool, the crate itself when DECX owns it), `decx-<tool>.json` (how the manager installs and verifies it) and a `README.md` (install, verify, upstream pin). Then add its skill at `skills/decx-<tool>/{SKILL.md,PURPOSE.md}` (commands, artifact contract, error contract). Never a wrapper around another skill; the tool id is the directory name without the `decx-` prefix.
2. Add one row to the `decx-vulnhunt` Targets table (`android-app` / `android-framework` / `native` style): track, artifact, tool entry, surface.
3. Add `wiki/patterns/<track>-<name>.md` pages for the non-obvious behavior using the card skeleton, and mirror them into `skills/decx-vulnhunt/references/patterns/`.
4. Add `skills/decx-vulnhunt/references/<track>-chains.md` (routing matrix built from the cards that exist — mark it bootstrap while it is thin) and list it under `## References`.
5. Add the evidence kinds the target needs; the core stays `entrypoint`, `reachability`, `control`, `guard`, `sink`, `impact`.
6. If the target is reproducible, add `skills/decx-poc/references/<platform>-poc-base.md`, one `<platform>-poc-<surface>.md` per surface, and a section in `decx-poc/references/index.md`.
7. `python3 skills/check-skills.py` and `node .pi/extensions/decx/cli.ts check` must both pass.
