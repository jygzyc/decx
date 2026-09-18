# PURPOSE.md — decx-init

Maintenance metadata for `decx_maintain` / `decx_propose`; not read during execution (see `skills/AGENTS.md`).

## Motivating patterns

None — the manager contract (install layout, PATH links, PROVENANCE, the `run` passthrough
and the Windows host rules) is DECX's own machinery, so it lives in this skill's `SKILL.md`
and not in a pattern card. The wiki catalog holds target patterns only.

## What the skill must keep

- The routing gate and the banned-layer list: this skill initializes an environment and
  launches tools; it never analyzes and never translates.
- The command contract: manager options before the tool id, one JSON object per data
  command, exit `0`/`1`/`2`.
- The install contract: `$DECX_HOME/bin` + `share/<id>/` + `PROVENANCE`, one pinned
  release tag, `--version`, `--from-source` only where declared, no shell startup edits.
- The workspace layers (`skills/`, `wiki/`, `raw/`) and which tools materialize them.

## Current state

Bootstrap: no `raw/` traces, no gated proposal in `wiki/skill-impact.md`.
