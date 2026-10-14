# Methodology: the locate → trace → bypass loop

The loop is a cost model: each phase below is priced in restarts and lost evidence.

## Table of Contents

- [What a blind hook costs](#what-a-blind-hook-costs)
- [What evidence means here](#what-evidence-means-here)
- [The ordering](#the-ordering)
- [Choosing the bypass point](#choosing-the-bypass-point-after-the-mechanism-is-proven)
- [Distilled field rules](#distilled-field-rules)
- [Recording a bypass for re-runs](#recording-a-bypass-for-re-runs)
- [Provenance](#provenance)

## What a blind hook costs

A hook installed on a *guess* (function "looks like" a detector, an offset copied from another version, a hook placed "where it usually is") fails in the worst way available to each mistake:

- **Wrong function**: you now observe noise while the real detector keeps running; every conclusion built on the observation is wrong.
- **Wrong timing**: hooks that fire after `.init` never see the check that killed you — the app dies and the conclusion "hook doesn't work" is wrong.
- **Wrong level**: patching `.text` on a self-verifying library converts a working app into a checksum mismatch — the crash you induced is indistinguishable from the defense you were evading.
- **Stacked guesses**: each extra "just in case" hook multiplies crash surface and hides which mitigation (if any) worked.

Every one of these destroys evidence and forces a restart from a worse position: the app may phone home, rate-limit, or switch defense profiles after repeated deaths.

## What evidence means here

A bypass hook is justified only by a chain, recorded in that order:

1. **Observation** — the target read this path / called this import / this function returned this magic number *at the moment of the kill decision* (`scripts/detect.js` sensors, its `observe[]` table).
2. **Disassembly agreement** — the decompiled branch keyed on that observed value selects the kill path (`==167`, `==248`, `cbz x0` …).
3. **Decision** — the ladder rung chosen, why the lower rungs fail (`references/detection-vectors.md` row, rung from `SKILL.md`).
4. **Result** — survived / killed / new signal; if killed, the next rung and what changed.

If any link is missing, run another observation pass.

## The ordering

- **Locate** narrows a whole process to one library, one thread, one input channel. Cheap, passive, no code modification.
- **Trace** narrows one library to exact offsets and values, still passive. Three moves, in order: **(a)** pin the thread and Stalker it (`detect.js` `stalker`) — instruction trace for one thread, dumped on the fault; read the dump backwards, the last frame inside the suspect `.so` is the detection source and everything between it and the fault is a consequence. **(b)** If the fault pc is not in mapped code, no Stalker run can ever see it — the mapping it lived in is gone; switch to exception capture (`detect.js` `exceptionHunt`), which attributes such addresses from a load-time snapshot (`frida-mapping-yanked`, `detector-probe`, `deliberate-kill`). **(c)** Close the trace by naming the feature the detector matched (`detect.js` `featureMatch`) — anonymous/`memfd:` exec mapping, signature string, ELF-vs-maps mismatch, thread name, fd/port. An unnamed feature is an unfinished trace: the bypass rung is chosen from the feature class.
- **Bypass** spends the evidence: one rung of the ladder, the least invasive that the evidence supports, and nothing stacked on top. `scripts/bypass-apply-located.js` is the canonical entry: it carries the traced finding as a `PATCHES` entry, the ordinary feature masking (port / process / path) and a VERIFY pass that re-probes through raw syscalls, so the test cannot fool itself. Acceptance = the trigger no longer kills the process; if it still dies, go back through locate and trace with the new evidence.

Passive phases are safe to repeat, so all repetition belongs before the bypass.

## Choosing the bypass point (after the mechanism is proven)

The evidence chain names the detector; *where* to cut it still has rules, all learned the hard way:

- **Patch the call site.** Where a kill function also serves legitimate paths, patching its body breaks them; patching the caller's `bl` to `mov w0,#0` confines the change to one path.
- **When the defense feature-detects your usual hook** (it checks whether `pthread_create` is hooked), move to a **lifecycle-downstream function** — `clone` under `pthread_create` — and cut there. Expect the counter-move: one more check closes it; eventually you must find the detection point itself.
- **A state flag is a decoy when no killer reads it.** Forcing a verdict/accounting state to "clean" changes nothing; killing the worker thread freezes the app with it. Find the function that performs the kill.
- **Multiple independent killers race.** Neutralizing one masks the rest and manufactures a confident wrong attribution. Attribute by capability (who *can* act bypassing libc?) and confirm with single-variable experiments.
- **Spoof the inputs.** UI suppression leaves the app's risk verdict, and its server-side report, intact; environment spoofing makes the checks read clean.

## Distilled field rules

Constraints that survived engagements, grouped by the phase each one constrains.

**Recon and attribution**

- **Packed targets: analyze the runtime image.** Locate the shell's execution region from segment layout (an RX LOAD segment with no ordinary code provenance), then find the scanner by xref'ing the `/proc/self/maps` and Frida-default-port strings against it.
- **A constructor that releases anonymous executable code** changes the analysis target: dump the mapping before and after the constructor, reassemble the dumps into ELF wrappers, analyze those — the released region carries the direct syscalls (root / Frida / `TracerPid` / Xposed / maps / memfd / integrity / timing). Corollary: with runtime-decrypted code the **absence of signature strings proves nothing**; confirm against live memory.
- **Identify the unpacker before choosing patch targets.** In packer-hardened targets the unpacker's caller return slot must carry a consecutive signature string; patching or jumping into it without that signature breaks unpacking (libart access violations, white screen, hang) even when the detection was neutralized. Plan detection-kill and unpacking separately.
- **Read death symptoms as a decision flow**: only `dlopen` onLeave fired → constructor-time detection or an inline `svc`; a `pthread_create` poller → ptrace/poller class; clean terminate with zero libc-hook hits → inline-syscall killer (capture a clean window first); "terminated" while `pidof` still lists the process → active strike against the agent; **SIGSEGV with the PC inside the guard's own constructor → a state-scan self-destruct through a poisoned-pointer deref** — find the walker and make it `return 0`.
- **Capability exclusion, operationalized.** Statically count inline `svc` instructions in the suspect library. With all libc exit hooks neutralized and the kill still happening, a library with **zero** inline syscalls cannot be the killer; one with an inline-svc table can.
- **Control experiment before attribution.** To test one suspected trigger, isolate it alone — map a bare anonymous `r-x` page containing `ret`, install no hooks, see whether the app survives. A survival result falsifies the hypothesis cheaply.
- **Return-value distribution beats a Stalker firehose.** Trace a candidate detector by recording offset → return value → branch semantics from the decompilation; the resulting decision table is the cheapest reliable proof that a function is a detector.
- **Trace the writer before trusting a value.** A suspicious static boolean can belong to an unrelated framework component. IO correlation — set a flag in a checker method's `onEnter`/`onLeave`, log native file IO only inside that window — finds the encrypted data source without decoding it (the writer may use raw syscalls invisible to libc hooks).
- **A recipe is valid for app + device + OS version + device state only.** Failed states persist across `pm clear` via app-written files and DBs, and the same binary can behave differently on a second device or OS (for example, no consent window). Retest on a second device before trusting a recipe.

**Choosing the patch**

- **`retval.replace()` on a pure predicate beats writing `.text`** — cheapest rung, no self-check artifact. Write `RET` only when the function's whole job is destructive (a `MOV X8,#imm; SVC #0` exit wrapper): overwriting the SVC with `RET` neutralizes it where no libc hook can see it.
- **Never attach to a library's own inline-svc stubs**: relocating those instructions breaks control flow and crashes the process — hook callers or neighbours instead.
- **A state-based scan is defeated at the walker.** When the guard enumerates the linker's `solist` (no `/proc` read at all) and self-destructs by dereferencing a poisoned pointer on the matched entry, patch the detection function entry to `return 0`: traversal, deref and verdict disappear together and the check reads "nothing found". Cost: a `.text` write, so it needs the Rule 4 evidence chain and re-locating per build (Rule 5).
- **Patch the value.** Where a shared function's verdict feeds legitimate callers, rewrite the value-producing instruction or return value (force a status `"0"`, zero the result register, semantic "file does not exist" returns) and leave the function alive.
- **A flattened dispatch block's first instruction can look like a function entry.** Do not write `RET` there; read the decompilation and fix the verdict comparison so control proceeds down the safe path.
- **Disable the whole dispatcher entry**: sibling branches re-arm other protections (a ptrace-blocking branch survives a "polling-only" patch).
- **Runtime-released code is patched right before it runs** (constructor-gated runtime patch): the disk file has nothing at that address.
- **On-device disk patch is a valid rung.** An already-extracted `.so` can be patched under the app's native library directory (replacing the extracted copy and leaving the APK untouched): no signature break, and it is re-applied before every launch, so it survives `pm clear`. Keep a `dlopen` monitor alive so later loads are patched too.
- **Patch child processes too.** Multi-process apps load the same guards in `:remote`-style services; a main-process-only agent leaves them active.
- **Enumerate the whole chain.** Independent guards spread over several `.so` files, or parallel SDKs where any single hit is fatal, are not defeated one patch at a time: patching one module leaves the others running, and neutralizing one detector does not buy a working app.
- **Patch from the outside in** when layers coexist: the active-strike / deletion layer must be neutralized before hook-integrity and async watchers, or the outer layer unloads the agent before the script finishes loading.
- **Prefer targeted byte patches over blanket libc hooks.** Per-call hooks on high-frequency functions cause UI jank and performance collapse; a stable bypass is a small patch set.
- **Acceptance bar for a multi-SO patch set** (fixed duration, no intervention): no SIGSEGV, no anonymous kill, no `FATAL EXCEPTION`, no ANR. Leave non-crashing, unattributed chains alone.
- **A wide blunt guard stack is a last resort.** When the killer is data-driven and further evidence runs are too expensive: block `connect()` across a broad range around the Frida defaults, blank Frida markers in `fopen`/`fgets`, `ptrace` onLeave → 0, `strstr` → NULL, benign `pthread_setname_np`, intercept `kill`/`tgkill` for SIGKILL/SIGABRT/SIGTERM, replace `exit`/`_exit`/`abort`/`raise` — with any exception handler scoped to a known-safe module list. Never stack it on top of an evidence-based bypass.

**Timing and environment**

- **Anchor the patch window inside the constructor.** The measured load ordering, why the first early-import call is the earliest patch window, the golden-window variant, and the hook-integrity caveat live in `references/detection-vectors.md` §Timing; scripts: the `anchor` sensor in `scripts/detect.js` for observation (`early-import` primary, `call-constructors` fallback when `.init_proc` imports nothing usable), `ANCHOR` in `scripts/bypass-apply-located.js` for patching at the same window.
- **A stub `Application` + `appComponentFactory` in the manifest is the earliest entry point** (it runs inside `attachBaseContext`): anything it starts is missed by attach, so spawning is mandatory even when later checks are consent-gated.
- **Late-mount differential:** let the app cold-start bare as a known-good baseline, then add exactly one hook or mitigation at a time — this separates cold-start race noise from steady-state detection.
- **Cross-ClassLoader reflection:** a class in a dynamically loaded dex is invisible to `Java.use` under the main factory. Use `Java.enumerateClassLoadersSync()` → find the loader that can `findClass` → `Java.ClassFactory.get(loader)`.
- **Runtime-registered natives with no exports or strings:** read the `ArtMethod*` `data_` field after `GetStaticMethodID`, or hook the `JNINativeInterface` `RegisterNatives` slot (`REGISTER_NATIVES_IDX = 215`) to enumerate class / method / signature / native address / module. The env-table edit is still detectable — combine it with a clean-window or late attach.
- **Capture plaintext at the last native choke point the guard does not own** (`bypass-ssl-plaintext-capture.js`): hooking `SSL_write`/`SSL_read` is far cheaper than unwrapping multi-layer transports, and Java-layer capture dies quickly. Find and watch the SDK's own reporting channel too — a purely local bypass leaves the server-side verdict intact.

## Recording a bypass for re-runs

A decision worth keeping is a decision worth re-executing on a new version. Record, per target: SO name + build fingerprint, anchor property, offsets with their branch semantics, rung chosen, result. Offsets die with the build; the *path* through the loop (anchor choice, magic-number table, rung reasoning) transfers. The `bypass-*` scripts (flat in `scripts/`) are exactly these records — copy their shape and re-locate their offsets.

## Provenance

This skill distills public write-ups (imported author knowledge — bootstrap material per repo policy; no measured rollout evidence backs it):

- xiusi, 看雪/XHS article《libmsaoaidsec.so 检测监测——绕过 Hook 脚本》 ("libmsaoaidsec.so detection monitoring — bypass hook scripts") — hook timing, anchor method, magic-number table, RET/NOP decisions.
- apkunpacker, 《脚本 | AntiFrida_Bypass》 ("Script | AntiFrida_Bypass") — the `/proc` vector catalog and sanitizing hooks, including their own crash-risk notes.
- 《Frida学习笔记（十七）：反调试与反检测对抗（上）》 — signal self-checks, fast-layer scope, consent-page window, native SSL capture.
- 《Frida学习笔记（十八）：反调试与反检测对抗（下）》 — environment/capability spoofing across parallel SDKs, golden-window patching, decoupled popups.
- 《Frida检测与绕过》 — generic vector list: ports, D-Bus, fd/task/maps, inline-hook bytes, io-redirect countermeasures.
- 《Frida学习笔记（二十八）：魔改 Frida · 从字节 patch 到环境伪装》 — the server-mod S0–S3 ladder and community-build comparison.
- 《【银行逆向百例】17》 — maps whitelist, direct-syscall kill, unpacker preservation.
- 《原版frida过某加密企业版，七个检测so，逆向分析简要流程》 — anonymous RX code, syscall-filter evidence, per-SO patch atlas.
- 《无壳app的libmsaoaidsec.so frida反调试绕过姿势》 and 《Frida检测绕过及so的加载流程》 — the linker-level `call_constructors` anchor.
- 《某企业壳frida检测另辟蹊径的绕过》 — the clone downstream-hook move.
