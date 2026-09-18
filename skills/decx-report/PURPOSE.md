# PURPOSE.md — decx-report

Maintenance metadata for `decx_maintain` / `decx_propose`; not read during execution (see `skills/AGENTS.md`).

## Motivating patterns

None — report intake, the issue model and the template contract are DECX's own machinery
and live in this skill: `references/finding-intake.md` (contract fields, id reuse,
composition field families) and `references/report-format.md` (section order, rating
presentation, template structure). The wiki catalog holds target patterns only.

## What the skill must keep

- The workflow order in `SKILL.md` (intake → re-verify → issue model → render) and
  its Rules table: report gates stay in the skill, not behind a wiki pointer.
- The default outputs (`report.html`, `report.zh.md`, `report.en.md`) and the shared
  finding ids and evidence model across formats.
- The finding-field contract stays in `decx-vulnhunt`; this skill consumes it by
  reference.

## Current state

Bootstrap: no `raw/` traces, no gated proposal in `wiki/skill-impact.md`.
