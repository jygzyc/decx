# PURPOSE.md — decx-droidasc

DECX tool id and launcher: `droidasc` (renamed from `asc` on 2026-09-16, when upstream
0.1.0 repackaged the tree as the `droidasc` package).

Maintenance metadata for `decx_maintain` / `decx_propose`; not read during execution (see `skills/AGENTS.md`).

## Motivating patterns

None beyond the app track — DroidASC is the DEX tool: an APK/JAR container is its input,
a bare `.dex` is not, and no DECX layer translates another tool's commands into it. The
invocation contract (argument order, `--gui` placement, an empty `findrefs` result read as
failure) is the skill's own `SKILL.md` section, not a card.

## What the skill must keep

- The routing gate (APK/JAR with DEX; not native code, not collection) and the
  `EOCD not found` rejection for a bare `.dex`.
- The verified command contract: positional order, where `--threads` / `--debug` / `-o`
  sit, the GUI path's separate parser and its detached launch semantics.
- The output contract: `getclass` source text, `findrefs` empty result is exit 0, and
  `--help` wins over any documented flag list.

## Current state

Bootstrap: no gated proposal; `--gui` evidence in `raw/traces/20260915-213750-asc-gui-spawns-a-detached-gui-child.md`.
