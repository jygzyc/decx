# Scripts

Reusable Frida assets for the anti-Frida loop — a flat directory, no subdirectories. **`detect.js` is the one detection script**: every locate/trace sensor is a CONFIG toggle inside it; each `bypass-*.js` is one special-case counter, the filename naming the case.

Server-side changes are not scripts here. Preserve one stock-server baseline; use **rusda** (XOR-hidden strings, renamed threads) on a non-default port only when the baseline implicates those features or stock Frida cannot keep an observation channel alive. See `references/frida-server-mods.md`.

## Invocation

Run from the skill directory. Edit only the CONFIG block at the top of `detect.js` (or the documented consts of a bypass script), then:

```sh
PKG=com.example.app
frida -U -f "$PKG" -l scripts/detect.js
# Custom server: adb forward tcp:8888 tcp:8888
# frida -H 127.0.0.1:8888 -f "$PKG" -l scripts/detect.js
```

Save the console output with the target package, APK version, ABI, SO build ID, Frida client/server versions, spawn/attach mode, and server port. These fields make the next pass and later offset validation reproducible.

## detect.js — the whole locate → trace loop in one file (passive)

Defaults are the canonical first run: `loadChain` (dlopen/`android_dlopen_ext` + `call_constructors` + `JNI_OnLoad` markers + kill-path VERDICT) and `exceptionHunt` (fault classification). Then enable exactly the sensor the last verdict points at — each extra hook is crash surface and a detectable artifact (SKILL.md Rules 2–3). Nothing in this file patches, blocks, or forges: the process stays free to die so the log records where it died.

| CONFIG sensor | Answers | Needs |
|---|---|---|
| `loadChain` (default on) | which `.so` load kills, and in which phase (`.init_array` / `JNI_OnLoad` / post-load poller); no KILL line at all = direct-syscall kill | nothing — run at spawn (`-f`) |
| `exceptionHunt` (default on) | kill shape: `frida-mapping-yanked` / `detector-probe` / `deliberate-kill` / `in-module-fault`; snapshots ranges+modules at load so "was mapped, now gone" attributes | nothing |
| `procWatch` | who reads `/proc/**` (maps/status/task/comm/smaps), attributed to the caller module | nothing |
| `threadWatch` | who creates threads, from where, named what — clone/clone3 creator backtraces, decoded flags, settled names, `pthread_setname_np` observer (export hooks can miss a direct-syscall path: absence of output is not proof of absence) | nothing; `ourLib` filters creators |
| `registerNatives` | runtime-registered JNI methods: class, name, signature, `module+offset` (VM table read-only) | nothing |
| `anchor` | fires `onAnchor` in the earliest window before the target's detector: `early-import` = inside `.init_proc`, `.init_array` not reached; `call-constructors` = before any constructor | `targetSo`; for `early-import`, a `property` the `.init` decompilation proves is read first |
| `observe[]` | detector return values (magic numbers) per `base+offset` candidate — the anchor arms it automatically | offsets + branch semantics from the decompiler |
| `stalker` | the exact instruction/call chain into the fault: pin ONE thread (`tid`/`name`, late threads caught via the setname hook) or scope to one module (`module`); ring dumped on fault — read backwards, the last suspect-`.so` frame is the source | the located thread or suspect module; `armOnModule` starts recording inside the suspect `.so` |
| `featureMatch` | the feature classes a detector COULD match right now (anon-exec, signature strings, ELF-vs-maps, thread names, fds/ports) — HYPOTHESES: correlate with an observed detector read before choosing a rung | nothing; `deepScan` widens the string scan |

RPC from the REPL: `__loadChain()` `__jniOnLoads()` `__threadReport()` `__featureReport()` `__excSnap()` `__stalkerWhere()` `__stalkerDump(n)` `__stalkerStop()` `__stalkerArm()`; `observerFor(base)` arms the observe table by hand. Patching in the anchor's constructor window is `bypass-apply-located.js`'s `ANCHOR` option — `detect.js` never patches.

## bypass-* — spend the evidence (invasive, ladder order)

| Script | Rung | Does | Needs |
|---|---|---|---|
| `bypass-apply-located.js` | **canonical entry** | one file for the whole bypass step (arm64-only, fails closed elsewhere): (1) `PATCHES` = the exact function/instruction that tracing named (`replace0` / `ret` / `ret0` / `nop`); `ANCHOR.targetSo` applies them in the constructor window (`early-import` / `call-constructors`) instead of polling, (2) `MASKS` = the ordinary Frida features (port / process / path) forged at the read level through raw syscalls — INERT until `ENABLE_RUNTIME_MASKS = true`, (3) `VERIFY` = two views per probe: hooked-libc view (PASS/FAIL — are the masks working) + raw-syscall residual (INFO — what a direct-syscall detector still sees); app survival under the traced trigger stays the manual acceptance test | the traced finding; `PORT` when the server port is randomized (rusda) |
| `bypass-fake-proc-sanitize.js` | L1 | sanitizes `/proc` reads at open/fgets/strstr/readlink level; first pass `OBSERVE_ONLY = true` | observation of what is read |
| `bypass-maps-redirect-open-replace.js` | L1 | redirects `/proc/*/maps` opens to a sanitized copy (self-arming: calls `mapsRedirect()` on load) | confirmed maps-only scanning; Frida 17-compatible (no legacy `File`) |
| `bypass-signal-selfcheck-neutralize.js` | L2 | neutralizes raise-a-signal-then-check-the-flag self-checks at `raise` | signal number, flag offset (decompiled handler) |
| `bypass-ret-patch-arm64.js` | L2 | writes `ret` at confirmed detector/poller entries (ARM64, via `Memory.patchCode` — no persistent RWX page); self-arms on module map (`AUTO_ARM` default, inert while the target table is empty) or call `retPatch(base)` yourself | evidence chain per offset; self-check risk |
| `bypass-dl-iterate-phdr-filter.js` | L1 | generic linker-state counter: wrap the `dl_iterate_phdr` callback, return 0 for frida SO names (keep the `NativeCallback` alive, Rule 6) | the detector walks modules via `dl_iterate_phdr` (a locate/trace result) |
| `bypass-ssl-plaintext-capture.js` | — (observation) | native `SSL_write`/`SSL_read` plaintext capture in whichever ssl/crypto module exports them: the app's own reporting channel, in cleartext | nothing — tune `MODULE_RE`; observation only, to check what the app still tells its server |
