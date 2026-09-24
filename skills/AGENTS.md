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

## Reference Architecture

A skill is self-contained: `SKILL.md` plus, when it carries reference knowledge, a
`references/` directory; nothing in a skill body may depend on the repository layout.
The pattern catalog lives in `wiki/` only — no skill mirrors pattern cards.

- A reference that belongs to one tool is named after the tool id
  (`decx-tool/references/droidasc.md`, `afe.md`, `kuna.md`) and carries that tool's
  whole contract; `SKILL.md` keeps only the routing between tools.
- A reference that only makes sense for one target carries the target prefix
  (`android-framework-*.md`); a second target adds its own `<track>-*.md` beside them,
  never a rewrite.
- A reference that applies to every target stays unprefixed (`index.md`).

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
- No `## Trace Commands` section — native tool command lines belong in `decx-tool/references/<tool>.md`, not in pattern cards.

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
  and the ledger is written only by `decx_propose` and `decx_gate`. The wiki is never rolled back,
  even when a skill proposal is.
- `track:` is the catalog's cross-project axis and names the *target*, not the analyzer.
  The four tracks are `android-app` / `android-framework` (over DroidASC/AFE),
  `android-poc` (the Android PoC harness set) and `native` (a native binary, Kuna).
  DECX's own machinery — the manager and the tools' command contracts — is never a
  track: it lives in `decx-tool`'s references, and the manager's own usage in
  `decx/README.md`. Wiring another analyzer into DECX
  adds cards under an existing track (or a new `<platform>[-<component>]` track) —
  never a second catalog.

### Bootstrap is not evidence

The current pages were seeded from authored skills and references — **bootstrap
material**, not empirical rollout evidence: no page has a measured rollout score.
Structural checks (`node .pi/extensions/decx/cli.ts check`, index sync,
frontmatter lint) verify maintenance hygiene, not validation performance. The
paper's harness validation split (train/validation/test gating of one proposal) is
not reproduced in this repository, so no page may claim a score it does not have and
no change may be called an improvement without a measured baseline/candidate
comparison on the same split.

### Wiki pages are the single copy

The wiki page (evidence, history, proposals) is the only artifact per pattern: no
skill mirrors pattern cards. If a skill grows a runtime mirror again
(`references/patterns/`), the duplication rules return — removing one copy becomes
the trigger to regenerate the other, and a card edit is mirrored on its page (and
vice versa). `PURPOSE.md` next to each `SKILL.md` is maintenance metadata for
`decx_maintain` / `decx_propose` — never read
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
proposer applies one existing skill-file candidate with `decx_propose`;
`decx_gate` accepts only a strictly better measured score on the same validation
split, otherwise restoring the skill while the wiki persists. Inference, maintenance
and proposal tool access is enforced by phase; see `.pi/extensions/decx/README.md`. Gate before committing a knowledge change:
`node .pi/extensions/decx/cli.ts check` (exit 1 on errors; it verifies
frontmatter, section skeleton, index sync and every markdown/wikilink target).

## Skill Inventory

Two skills. Session procedure and maintenance are tools, not skills, and the
manager's own usage is `decx/README.md`, not a skill. The skills live in the
repository's `skills/` directory. `decx-tool` drives the installed tools;
`antifrida-bypass` owns a process, not a tool — it is tool-agnostic (plain
`adb`, `frida`, DroidASC, Kuna or `objdump` all serve it) and installs nothing.

| Skill | Track / target | Scope |
|---|---|---|
| `decx-tool` | `android-app`, `android-framework`, `native` | Every installed tool in one skill: DroidASC (DEX decompiling and cross-references on APK/JAR containers), AFE (framework collection and preprocessing, live device reads) and Kuna (native binaries and ET_REL objects). `SKILL.md` holds the routing gate and the install/launch contract; each tool's commands, identifier, output and error contracts live in `references/<tool>.md`. The Kuna reference is upstream's own skill file, re-copied when the pin moves. |
| `antifrida-bypass` | `native` (Android) | The locate → trace → bypass loop for native anti-Frida / anti-debug in a shipped or pulled `.so`: detection vectors (`/proc` and maps reads, linker `solist` and `dl_iterate_phdr` module walks, thread-name and port probes, signal self-checks, CRC self-verification), the `.init`-anchored patch window that precedes `.init_array` detection, and the build-your-own `frida-server` ladder. Every hook is preceded by evidence; `.text` patches carry the Rule 4 evidence chain and Rule 5 version-pinning. Tool-agnostic by design: the loop runs on whatever `adb`/`frida`/DroidASC/Kuna the analyst already has, so this skill installs nothing. |

### Adding a target or analyzer

A new analyzer is one section in `decx-tool` plus its subproject; a new target is a
track.

1. Add the tool as a subproject `subprojects/decx-<tool>/`: the checkout it installs (`source/` for a vendored tool, the crate itself when DECX owns it), `decx-<tool>.json` (how the manager installs and verifies it) and a `README.md` (install, verify, upstream pin). The tool id is the directory name without the `decx-` prefix.
2. Add the tool to `skills/decx-tool/`: a row in `SKILL.md`'s routing gate plus `references/<tool>.md` carrying the commands, artifact contract, error contract and install. When the tool ships its own agent skill (as Kuna does), that reference is the upstream skill file copied verbatim with only its frontmatter dropped; re-copy it when the pin moves, never edit it, and keep the DECX install contract in `SKILL.md`. A drift check belongs in the tool's workflow (`decx-kuna.yml`).
3. Add `wiki/patterns/<track>-<name>.md` pages for the non-obvious behavior using the card skeleton, through `decx_maintain`.
4. `python3 skills/check-skills.py` and `node .pi/extensions/decx/cli.ts check` must both pass.
