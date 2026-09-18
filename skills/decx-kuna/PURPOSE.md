# PURPOSE.md — decx-kuna

Maintenance metadata for `decx_maintain` / `decx_propose`; not read during execution (see `skills/AGENTS.md`).

## Motivating patterns

- `wiki/patterns/native-kernel_modules.md` — a sourceless `.ko` is an ET_REL
  object: it decompiles unlinked and `object_location` maps a function back into the
  module, which is the non-obvious part of vendor-module triage.
None beyond the native track — Kuna is the native tool and nothing in DECX translates
DroidASC commands into it; the subcommand/flag contract (`--to`/`--from`, real
`sub_<addr>` selectors, help on stderr) is the skill's own `SKILL.md` section.

## What the skill must keep

- The routing gate (ELF/PE/Mach-O and ET_REL; not DEX, not framework collection).
- The verified command and flag contract, including the empty-xref and empty-strings
  readings that otherwise look like dead ends.
- The ET_REL section: unlinked decompilation, module-base addresses, `object_location`
  and the ioctl-dispatch triage start.

## Current state

Bootstrap: no gated proposal; ET_REL evidence in `raw/traces/20260915-213620-kuna-decompiles-et-rel-kernel-module-objects.md`.
