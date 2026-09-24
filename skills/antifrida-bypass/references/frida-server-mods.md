# Frida-server modification ladder (S0–S3 deep-dive)

## Table of Contents

- [S0 — byte patching](#s0--byte-patching)
- [S1 — source patching](#s1--source-patching-frida-16x-paths)
- [Community builds](#community-builds-pick-dont-build-when-possible)
- [When a script cannot help](#when-a-script-cannot-help--swap-the-server)
- [S2 — removing the daemon](#s2--removing-the-daemon)
- [S3 — environment disguise](#s3--environment-disguise-adjacent-to-this-skill)
- [Port evasion cheat sheet](#port-evasion-cheat-sheet)

Start with an unmodified, client-matched server long enough to preserve a baseline. Use rusda only when evidence implicates server-visible strings, thread names, or ports, or when stock Frida cannot keep an observation channel alive. rusda is a pre-patched server with compile-time XOR-encoded strings and renamed threads/entries. Deploy it on a non-default port (`./rusda-server -l 0.0.0.0:<port>`) and record the changed variables. This skill ships no server-patching scripts.

**Stop at the level that works** — do not escalate preemptively. The four investment levels:

| Level | What | Effort | Defeats |
|---|---|---|---|
| 0 | byte-patch strings in the released binary | ~10 min | grep-style scans (~30% of detections) |
| 1 | patch frida + GLib sources, self-build | 2–3 h | most thread-name/string scans (~70%) |
| 2 | skip the daemon entirely (custom injector / gadget / Zygisk) | days–weeks | all "frida-server exists" class |
| 3 | Magisk module + environment disguise (resetprop, DenyList/Shamiko) | 1–2 days | environment-level checks (95%+) |

Before climbing a level, reproduce the crash on-device and locate the actual death cause — same evidence rule as the hook ladder.

## S0 — byte patching

Hard constraint: **equal-length replacement** (a length change breaks the ELF layout). Proven swaps: `re.frida.server` → `re.fooey.server` (15 B), `frida-server` → `fooey-server` (12 B), `frida-agent` → `fooey-agent` (11 B). Workflow: `grep -aob "re.frida.server" frida-server` for offsets → replace with python `data.replace(old, new)` → push.

Deployment facts that matter for process-name scans:

- `/proc/<pid>/comm` (what `ps -A` shows) comes from the **executable filename at execve time, truncated to 15 bytes** — so push the binary under a plain name like `/data/local/tmp/syshelperd`.
- `/proc/<pid>/cmdline` comes from `argv[0]` — override with `exec -a system-helper ./syshelperd` (mksh supports `-a`) without touching `comm`.

Limits: S0 cannot change the agent's `gum-js-loop` thread name, the `frida` strings inside the target's memory, or the agent name a `dl_iterate_phdr` walk sees — and **the port 27042/27043 stays**. Deep scanners that grep the server binary for `frida:rpc` defeat renames.

## S1 — source patching (Frida 16.x paths)

Five canonical locations (paths move between majors — locate by keyword grep):

1. gum thread name: `frida-gum/bindings/gumjs/gumscriptbackend-qjs.c`, `g_thread_new("gum-js-loop", …)` → e.g. `"sysworker-1"`.
2. `gmain` lives in the GLib subproject of the Frida checkout (`frida/subprojects/glib/glib/gmain.c`), not frida sources — either patch GLib at build, or post-build equal-length `sed -b -i 's/gmain/rmain/g' build/frida-core/server/frida-server`.
3. agent SONAME: `frida-core/lib/agent/meson.build` `agent_symbol_name = 'frida-agent'` → `'libhelper'`.
4. D-Bus service: `frida-core/src/host-session-service.vala` `SERVICE_NAME = "re.frida.server"` → custom.
5. protocol magic `":rpc"` prefix — usually **do not** touch (breaks the protocol); only if a scanner provably matches it.

Build: NDK + `make -f Makefile.linux.mk FRIDA_TARGET=android-arm64` (or meson/ninja). Maintain as `git format-patch` series re-applied on new versions. Verify after deploy: `cat /proc/$(pidof <pkg>)/task/*/comm | sort -u` (expect your renamed workers, never `gum-js-loop`/`gmain`).

## Community builds (pick, don't build, when possible)

| Project | Approach | Known gaps |
|---|---|---|
| **Florida** | strongR superset + `g_set_prgname` (kills `pool-frida*`), memfd renamed `jit-cache`, auto-injects anti-anti script | **ports 27042/27043 unchanged**; `re.frida.*` client strings kept; rodata constants scannable |
| **rusda** | compile-time XOR-encoded strings (decoded only on the stack) + LIEF `.rodata` reversal + entry symbol renames | still a daemon; ports unchanged; keeps `frida:rpc` |
| **strongR-frida** | 8 classic patches (base64-decoded `frida:rpc`, random DBus dir, linjector fifo rename, UUID agent name, symbol rewrite, thread-name sed, silent protocol errors) | unmaintained; no XOR, no pool-frida |
| **fridare** | Go equal-length hex replacer (PE/Mach-O/ELF), GUI | no symbol-table work, no 11-byte `gum-js-loop` swap |
| **HLuda** | legacy de-featured builds (`REJECT`→`ACCESS`, `data:rpc`) | historical; predecessor line to Florida |

Decision heuristics: no building + mainstream commercial app → Florida release; Florida dies to memory-string scanners → rusda's XOR; both die → S2/S3 by hand.

Deploy contract (rusda or any community build): client and server versions must match **exactly, down to the minor** (16.5.x pairs only with 16.5.x). Rename the binary on push (`/data/local/tmp/sysmon`), run it on a custom port (`./sysmon -l 0.0.0.0:38291`), `adb forward tcp:38291 tcp:38291`, then `frida -H 127.0.0.1:38291 -f <pkg> -l <your-hook>.js` (spawn; attach to a running app with `-N <pkg>` — `-F` is frontmost-only and takes no package argument).

## When a script cannot help — swap the server

Three detections are beyond any injection-side script; each names the level that answers it:

1. The hardened SO **scans its own readable memory** for `LIBFRIDA` / `gum-js-loop` byte sequences — strings cannot all be erased at runtime → S1/S2 build (hidden or XOR-decoded strings).
2. It fingerprints the **D-Bus AUTH handshake** (connect, send auth bytes, read `REJECT`) — moving the port treats the symptom; only a build without the AUTH reply answers it.
3. It **compares the first 16 bytes of multiple libc/libart functions** against trampoline signatures — avoid the scanned functions or change the trampoline mode in a self-built Frida.

## S2 — removing the daemon

The daemon has four structural exposures: resident process, open port, IPC socket, agent injection artifacts — string patches cannot hide the first two. Options: **frida-gadget** embedded in a repackaged APK (`--enable-jit --script` — no daemon/port/socket at all); a **Zygisk module loading the gadget at zygote fork** (closest to ideal); frida-inject single-shot + S1/S3 combo (~80%); in-process gum embedding (`gum_init_embedded` + script backend) is possible but injection itself is the hard part (`process_vm_writev` writes data, triggering execution still needs ptrace — transient TracerPid).

## S3 — environment disguise (adjacent to this skill)

resetprop basics: `ro.debuggable 0`, `ro.secure 1`, `ro.build.type user`, `ro.build.tags release-keys`, `ro.boot.verifiedbootstate green`, `ro.boot.flash.locked 1`, `ro.boot.veritymode enforcing` — set in `post-fs-data` (Apps cache `Build.*` at first read). Zygisk DenyList + Shamiko hides Magisk from a target's mount namespace. Hardware attestation (KeyMint) cannot be resetprop'd. Out of scope beyond this pointer.

## Port evasion cheat sheet

On device: `./frida-server -l 0.0.0.0:8888 &` (or `-l 0.0.0.0:0` for a random port). Host over USB: `adb forward tcp:8888 tcp:8888` then `frida -H 127.0.0.1:8888 -l <your-hook>.js -f com.example.target`. WiFi: `frida -H <phone-ip>:8888 …`. Probes walk `/proc/net/tcp`, so a moved port only helps until the prober connects and reads the D-Bus `REJECT` reply — pair with a renamed/patched server.
