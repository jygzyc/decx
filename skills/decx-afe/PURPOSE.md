# PURPOSE.md — decx-afe

Maintenance metadata for `decx_maintain` / `decx_propose`; not read during execution (see `skills/AGENTS.md`).

## Motivating patterns

- `wiki/patterns/android-framework-*.md` — the framework track's cards cover the analysis
  side (Binder trust boundaries, native surfaces); AFE's own contract — it produces files,
  never analysis, and a framework target is a three-tool flow (AFE for collection, DroidASC
  for the packed jar, Kuna for its native libraries) — lives in this skill's `SKILL.md`
  with the ordering (`collect` → `process` → DroidASC), the `out_tmp` removal unless
  `--keep-outputs`, and the ADB requirement for device commands.

## What the skill must keep

- The routing gate: collection/preprocessing and live device reads only; decompilation
  stays with `decx-droidasc`.
- The command orderings and the `--keep-outputs` / `afe pack` relationship.
- The rule that exact flags and JSON fields come from AFE's own `--help`.

## Current state

Bootstrap: no `raw/` traces, no gated proposal in `wiki/skill-impact.md`.
