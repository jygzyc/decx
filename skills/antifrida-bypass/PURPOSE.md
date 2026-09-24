# PURPOSE.md — antifrida-bypass

Maintenance metadata for `decx_maintain` / `decx_propose`; not read during
execution (see `skills/AGENTS.md`).

## Motivating patterns

No wiki pattern motivates this skill yet. It is bootstrap material imported from
author knowledge; no rollout evidence exists for it. It is built on anti-drift
methodology and carries no pattern cards, so there are no pattern slugs to cite.

When real engagements produce `raw/` traces, the expected shapes to create
through the trace → pattern → proposal loop are
`native-early_init_detection` (a detector that runs from `.init`/`.init_array`
before `JNI_OnLoad`), `native-proc_scan` (a guard driven by filesystem reads),
`native-module_list_walk` (a guard that walks the linker `solist` instead of
`/proc`) and `native-signal_selfcheck` (SIGTRAP self-checks, inline-syscall
kills). Gate them in `wiki/skill-impact.md` before this file changes.

## What the skill must keep

- **Locate → trace → bypass, in that order.** A hook without a prior observation
  is banned; the ban is stated in `SKILL.md` (Rule 1) and carried by the loop
  sections (`### 1. Locate`, `### 2. Trace`, `### 3. Bypass`).
- **The patch window inside the constructor.** `android_dlopen_ext` onEnter →
  the module's own `.init_proc` early import (`__system_property_get`) → base
  known, `.init_array` not yet reached → patch (Rule 8,
  the `anchor` sensor in `scripts/detect.js`). `onLeave` and `JNI_OnLoad` are already late
  for a `.init_array` detector. The anchor is itself a detection point, so it is
  scoped and dropped once the base is pinned.
- **Choose the bypass class from observed evidence and escalate only on a
  demonstrated failure** (Rule 7): server-visible features → server change;
  read data → scoped input forgery; confirmed control flow → hook or patch.
  A working mitigation is never stacked with others "for safety"
  (`references/frida-server-mods.md`).
- **A `.text` patch carries the Rule 4 evidence chain and Rule 5
  version-pinning.** State-based scans are defeated at the walker (`return 0` at
  the detection function entry), not at the input.
- **No per-app analysis cases and no app-specific offsets**: they are
  version-pinned, they age and they mislead (Rule 5). Only transferable
  experience stays, and the skill is self-contained — `SKILL.md` plus
  `references/`, loaded one at a time, with no repository-relative paths in the
  body.

## Current state

Bootstrap: imported author knowledge (13 articles — 看雪, apkunpacker, and an IMA
knowledge base) consolidated into `SKILL.md` plus three references and 20
scripts; no `raw/` execution traces, no measured validation split, no gated
proposal in `wiki/skill-impact.md`.
