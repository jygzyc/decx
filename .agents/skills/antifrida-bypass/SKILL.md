---
name: antifrida-bypass
description: "Guides evidence-driven diagnosis and bypass of native Android anti-Frida or anti-debug defenses when an app dies, degrades, or defeats hooks after Frida attaches; detection may run before JNI_OnLoad or inspect proc/maps, threads, symbols, ports, linker state, signals, or code integrity. Enforces locate → trace → bypass: every invasive action follows observed evidence. Excludes ordinary Frida scripting, Java-only checks, non-hostile SSL unpinning, and non-Android targets."
---

# Anti-Frida Bypass

Defeating native anti-Frida / anti-debug defenses by locating the detector first, tracing what it actually checks second, and bypassing with the least invasive tool last. **Blind bypassing is banned**: an invasive hook without a prior observation is a guess, and guesses on hostile code crash the app and destroy evidence.

## Routing Gate

Use this skill only when Frida changes an Android target's native behavior: attach/spawn causes death or degradation, an early native detector defeats hooks, or evidence points to native anti-debug checks. Route Java-only checks, cooperating targets, generic SSL pinning, and non-Android work elsewhere.

## Rules

1. **Locate → trace → bypass, in that order.** Name the killer (which `.so`, which thread, what it reads) before writing a bypass hook.
2. **Preserve the baseline.** First reproduce with an unmodified, client-matched Frida server and record server port, spawn/attach mode, death timing, and last output. Do not start with rusda: renamed threads and strings can erase the evidence that identifies the detector. If stock Frida cannot keep an observation channel alive, use rusda on a non-default port as an explicit L0 experiment and record exactly what changed. Server options and limits are in `references/frida-server-mods.md`.
3. **Observe-only first.** Any sanitizer script runs its first pass with `OBSERVE_ONLY = true` — log what the target reads, then and only then decide what to forge.
4. **Never write to `.text` without an evidence chain.** RET/NOP patches trip CRC / self-verification. Required evidence: magic-number observation (the `observe[]` table in `scripts/detect.js`) cross-checked against the decompiled branch.
5. **Offsets are version-pinned.** Any recorded offset belongs to one build of one `.so`. A different version means re-locating from the disassembly.
6. **NativeCallback lifetime**: keep references in a `Set` (or module scope) — a GC'd `NativeCallback` becomes a wild pointer in the linker and crashes the process instantly.
7. **Climb the bypass ladder only on demonstrated failure.** A working rung ends the pass; stacked hooks multiply crash surface.
8. **Timing is part of the bypass.** A patch must land *after* the module is mapped and *before* its detector runs: `android_dlopen_ext` onEnter → the first early import the module calls in `.init_proc` (e.g. `__system_property_get`) → base known, `.init_array` not reached → patch (`bypass-apply-located.js` with `ANCHOR.targetSo`; the same window arms observation via `anchor` in `scripts/detect.js`). `onLeave`/`JNI_OnLoad` are already too late for a `.init_array` detector. That anchor call is itself a detection point: keep the hook scoped and never depend on it after the base is pinned.

## Start Here

Set `PKG` and begin with the single detection script on stock Frida (defaults are the canonical first run: load chain + kill-path VERDICT + exception classification):

```sh
PKG=com.example.app
frida -U -f "$PKG" -l scripts/detect.js
```

Reproduce once and save the final output. Follow its verdict by enabling exactly one sensor in `detect.js`'s CONFIG block (the Locate table names which) — not by stacking scripts. Before a trace or bypass run, edit only the documented inputs (CONFIG block, or a bypass script's consts), then run with the same command shape. Each pass must end with one recorded artifact and one next decision. Invocation variants (custom server port) and full per-sensor/per-script inputs: `scripts/README.md`.

## The Loop

### 1. Locate — name the killer

Goal: which library kills, from which thread, by reading what.

| Symptom | Start with |
|---|---|
| **Which `.so` load kills, and in which phase** (default first run) | `scripts/detect.js` defaults — load chain + `JNI_OnLoad` phase markers + kill-path VERDICT + exception classification; no KILL line at all = direct-syscall kill |
| **Who creates the detection threads** | `detect.js` + `threadWatch.enabled` — creator backtrace offset, child tid, settled thread name |
| Suspect `/proc` reading | `detect.js` + `procWatch.enabled` — every `/proc/**` open/readlink attributed to its caller module |
| Death with **no** `/proc` access and no exit syscall — a SIGSEGV inside the security lib | state scan (linker `solist` walker → poisoned-pointer self-destruct): trace the walker with `detect.js` `stalker` (`tid`/`name`), then `return 0` at its entry (`references/detection-vectors.md` §Linker and module state) |
| JNI-level tripwire | `detect.js` + `registerNatives.enabled` |

Artifact: `so=<name>, thread=<tid/module>, reads=<paths/symbols>, trigger=<timing>`.

### 2. Trace — confirm the mechanism

Goal: turn suspicion into an observed signal at the exact code location.

| Signal | Tool |
|---|---|
| Detection starts before `JNI_OnLoad` | `detect.js` + `anchor.targetSo` — fires at the earliest window still before `.init_array`: mapped + inside `.init_proc` + detector not yet run |
| Candidate detector functions | `detect.js` `observe[]` — observe-only `base+offset` table, logs return values (magic numbers) per branch; the anchor arms it automatically |
| Detection runs from `.init`/`.init_array`, before any import of the SO is callable | observation: `anchor.mode = 'call-constructors'`; patching at that window: `bypass-apply-located.js` `ANCHOR` — fires only when the current `soinfo`'s soname IS the target |
| Detection runs inside `JNI_OnLoad` (`.init_array` holds only compiler ctors) | golden-window patch: `android_dlopen_ext` **onLeave** — base known, ctors done, `JNI_OnLoad` not yet called; verify original bytes at each patch site before writing |
| **The fault: which instruction, after which chain** | `detect.js` `stalker` — Stalker pinned to ONE thread (`tid`/`name`); on fault it dumps signal, pc, registers, backtrace and the last `dumpN` events — read backwards; the last suspect-`.so` frame is the source |
| Fault whose pc is not in mapped code (the defense unmapped Frida's own page) or a deliberate `abort`/`exit`/`tgkill` | `detect.js` `exceptionHunt` (default on) — classifies the kill shape (`frida-mapping-yanked`, `detector-probe`, `deliberate-kill`) and names the caller module |
| **Which feature could the detector match** | `detect.js` `featureMatch.enabled` (or `__featureReport()`) — HYPOTHESES by class (anon-exec, strings, ELF-vs-maps, thread names, fds/ports); correlate with an observed detector read before choosing a rung |
| Module-scoped call/ret trail only (thread still unknown) | `detect.js` `stalker.module = '<name>'` |

One detection file, one runtime: the anchor's `onAnchor` arms the `observe[]` table automatically. Only the special-case scripts compose with it via multiple `-l`.

Artifact: `base + offsets → magic numbers → branch meanings` (from the decompiler), i.e. which function's return value selects the kill branch.

### 3. Bypass — least invasive tool that provably works

Ladder, cheapest first; each rung down increases both blast radius and self-check risk. Climb only when the current rung fails:

| Rung | Class | Tool | When |
|---|---|---|---|
| L0 | environment | **rusda** (pre-patched frida-server) run with `-l 0.0.0.0:<custom-port>` | thread-name / port probes (gum-js-loop, gmain, gdbus, pool-frida; default 27042) |
| L1 | data | `bypass-fake-proc-sanitize.js` | detection reads `/proc/*` content — forge at the read level (open/fgets/strstr/readlink) |
| L1 | data | `bypass-maps-redirect-open-replace.js` | only `/proc/*/maps` matters — redirect open to a sanitized copy |
| L2 | control-flow | `bypass-signal-selfcheck-neutralize.js` | raise-a-signal-and-check-the-flag self-checks (the handler clears a flag the detector then re-reads) |
| L2 | control-flow | `bypass-ret-patch-arm64.js` | confirmed kill/poller entries — RET at entry (evidence chain required, Rule 4) |
| L3 | code | per-target patch set (`PATCHES` in `bypass-apply-located.js`) | every exit path guarded by version-pinned offsets — replace each entry with `return 0`, including a **state-scan walker** (linker `solist` traversal) |

**Semantics matter at L3:** a patched callback must return `0` as `int`/`long`; a `void` callback SIGSEGVs where the caller tests `w0` (`cbz x0`). For a state-scan walker, returning `0` skips the traversal *and* the poisoned-pointer self-destruct together.

`bypass-apply-located.js` is the common apply-and-verify harness (arm64-only). `PATCHES` and `MASKS` ship inert: fill only the entries the selected row justifies, then set `ENABLE_RUNTIME_MASKS = true` for a mask rung. `ANCHOR.targetSo` moves the patch into the target's constructor window (`early-import` or `call-constructors`) when polling would land after a `.init_array` detector. Its VERIFY prints two views per probe — the hooked libc view (PASS/FAIL: are the masks working) and the raw-syscall residual (INFO: what a direct-syscall detector still sees).

The app's verdict may live on the server: watch the SDK's reporting channel while verifying (`scripts/bypass-ssl-plaintext-capture.js` captures plaintext at `SSL_write`/`SSL_read`). Every script is a re-runnable shape whose offsets must be re-located on the actual build (Rule 5).

## References

Load only the reference the observed signal points at:

- `references/detection-vectors.md` — catalog of anti-Frida vectors grouped by observable (what is read/checked), with the matching countermeasure class.
- `references/frida-server-mods.md` — the S0–S3 frida-server modification ladder (byte patch → source patch → daemon removal → environment disguise), five source locations, community builds (Florida/rusda/strongR/fridare), port evasion, when renames stop working. The skill's rung ladder above uses L0–L3; this file names the server ladder S0–S3.
- `references/methodology.md` — the evidence chain, the cost of wrong hooks, how to record a bypass decision so it can be re-run.

Script inventory with per-file usage lines: `scripts/README.md`.
