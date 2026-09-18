# PURPOSE.md — decx-poc

Maintenance metadata for `decx_maintain` / `decx_propose`; not read during execution (see `skills/AGENTS.md`).

## Motivating patterns

- `wiki/patterns/android-poc-harness_base.md` — the manifest/Gradle/signing traps that
  break a naive harness; the spec field list and the one-finalized-finding-per-spec rule
  are this skill's own `references/poc-spec.md`.
- `wiki/patterns/android-poc-activity.md`, `wiki/patterns/android-poc-broadcast.md`,
  `wiki/patterns/android-poc-provider.md`, `wiki/patterns/android-poc-service.md`,
  `wiki/patterns/android-poc-webview.md` — the target shape decides the harness
  mechanics, so per-surface mechanisms live apart from the base harness.
- `wiki/patterns/android-poc-framework_service.md`,
  `wiki/patterns/android-poc-environment.md`, `wiki/patterns/android-poc-evidence.md` —
  framework PoCs go through direct Binder calls, the environment is checked before
  a build, and a PoC is only proof when it logs a real signal.

## What the skill must keep

- The deliverable contract in `SKILL.md` (`state`, `projectPath`, `findingId`,
  `exploitId`, `trigger`, …), the Rules table, and the spec field list: a PoC is
  built from the finding writeup, not from the analysis session.
- Skill-relative commands: `scripts/check-env.mjs` runs with the skill directory as
  the working directory.
- Compile and deploy stay explicit-request only; the default deliverable is a
  build-ready project.

## Current state

Bootstrap: no `raw/` traces, no gated proposal in `wiki/skill-impact.md`.
