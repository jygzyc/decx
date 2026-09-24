# PURPOSE.md — decx-tool

Maintenance metadata for `decx_maintain` / `decx_propose`; not read during execution (see `skills/AGENTS.md`).

## Motivating patterns

- `wiki/patterns/android-framework-*.md` — the framework track's cards cover the analysis
  side (Binder trust boundaries, native surfaces); this skill's own contract — AFE
  produces files, never analysis, and a framework target is a three-tool flow (AFE for
  collection, DroidASC for the packed jar, Kuna for its native libraries) — lives in the
  skill's `SKILL.md` routing gate with the ordering (`collect` → `process` → DroidASC);
  the `out_tmp` removal unless `--keep-outputs` and the ADB requirement for device
  commands live in `references/afe.md`.
- `wiki/patterns/native-kernel_modules.md` — a sourceless `.ko` is an ET_REL
  object: it decompiles unlinked and `object_location` maps a function back into the
  module, which is the non-obvious part of vendor-module triage.

## What the skill must keep

- `SKILL.md`: the routing gate (which tool for which input, the bare-`.dex` `EOCD not
  found` rejection, the three-tool framework flow) and the install/launch contract.
- DroidASC's verified command contract: positional order, where `--threads` /
  `--debug` / `-o` sit, the GUI path's separate parser and its detached launch
  semantics, and `findrefs`' empty result being exit 0.
- AFE's command orderings and the `--keep-outputs` / `afe pack` relationship; the rule
  that exact flags and JSON fields come from AFE's own `--help`.
- `references/kuna.md` stays upstream's own skill
  (`subprojects/decx-kuna/source/skills/kuna/SKILL.md`) copied verbatim with only its
  frontmatter dropped; when the pin moves, re-copy it rather than editing it — routing
  and command rules belong upstream. `.github/workflows/decx-kuna.yml` fails when the
  reference drifts from the pin.

## Current state

Bootstrap: no `raw/` traces of the merged skill, no gated proposal in `wiki/skill-impact.md`.
