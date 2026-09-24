# Detection Vectors — catalog by observable

What hostile native libraries check, grouped by what you can observe, with the countermeasure class that matches. Use this table after the locate phase tells you what the target reads or calls; pick the row whose observable you saw, then the matching rung in `SKILL.md`'s ladder.

## Table of Contents

- [Reading `/proc` content](#reading-proc-content)
- [Network and protocol signatures](#network-and-protocol-signatures)
- [Probing the environment](#probing-the-environment)
- [Linker and module state](#linker-and-module-state)
- [Self-integrity and control flow](#self-integrity-and-control-flow)
- [Feature classes](#feature-classes--what-the-trace-must-end-on)
- [Timing](#timing-why-hooks-never-fire)
- [Field-observed realities](#field-observed-realities-distilled)

## Reading `/proc` content

| Observable | Vector | Countermeasure class |
|---|---|---|
| `open("/proc/<pid>/maps")`, then `strstr`/manual scan for frida strings (`frida-agent-64.so`, `frida-agent-32.so`, `frida-server`, `frida`, `re.frida.server`, `linjector`) | memory-map scan | L1: sanitize at `fgets`/`strstr` level, or redirect `open` to a forged copy |
| parse maps `rw-p`/`r--p` lines, `memcmp "frida"` on a 4-byte stride over mapped segments | whole-memory string scan (residuals: `frida`, `gum-js`, `gum-log-file`, `linjector-`, `GumScript`, `gumjs-runtime`) | L0: a server whose strings are hidden at runtime (XOR/reversed; `references/frida-server-mods.md`) — these bytes live in readable memory, so a read-level sanitizer has no single call to hook |
| byte-wise `read(fd, buf, 1)` reassembling `/proc/<pid>/task/<tid>/comm` strings | thread-name scan, immune to line-level sanitizing | L0: rusda — a pre-patched frida-server whose threads no longer carry those names |
| Java `Files.readAllBytes(.../comm)` + `contains(...)`, or C `opendir("/proc/self/task")` + `readdir` + `strstr` then `_exit` | same thread names from either layer; the C variant exits via direct syscall, so a libc `exit` hook never sees it | S1 source patch (`references/frida-server-mods.md`); do not rely on hooking `exit` |
| `readlink` on `/proc/self/fd/*`, `/proc/<pid>/exe` | fd/exe origin check (`/memfd:frida-agent`, `/memfd:gum-js-loop` classics) | L1: rewrite the link result (`bypass-fake-proc-sanitize.js` §readlink). Version note: **Frida ≥ 16** dropped `memfd:frida-agent` naming (anonymous tmpfs) and Android 10+ anonymizes memfd names — fd scanning is mostly dead against modern agents |
| `/proc/<pid>/status` → `TracerPid:` | classic anti-ptrace. Nuance: frida ≥ 16 steady-state reads 0 — only the injection window is non-zero, so defenders poll for the transient | usually irrelevant under Frida; catching the window is their problem |
| `/proc/net/tcp` walked for open ports, then probed; `netstat -tuln`; Java `new Socket("127.0.0.1", 27042)`; one bank shell sends a websocket probe | default-port probe: **27042** main, **27043** aux/DBus — string-patched servers still listen there, the port survives S0 | L0: non-default port (launch rusda with `-l 0.0.0.0:<port>`) |
| `/proc/net/unix` matching `/data/local/tmp/re.frida.server/linjector-*.sock` | IPC socket scan | rusda alone does **not** randomize this path (it keeps `re.frida.*`); a random `linjector` fifo/DBus dir is an S1/community-build feature (strongR-frida) |
| `/proc/<pid>/mounts`, `/proc/filesystems` | root/Magisk markers (`/sbin/.magisk`, magisk) | L1 sanitize; root artifacts beyond frida are out of scope |

Thread names that betray frida (gum's own threads): `gum-js-loop`, `gmain`, `gdbus`, `pool-frida`, `pool-spawner`, plus any `frida*`/`linjector` file names.

## Network and protocol signatures

| Observable | Vector | Countermeasure class |
|---|---|---|
| `connect()` to a local port, then D-Bus auth bytes (`\0` / `AUTH`); frida-server's reply starts with `REJECT` | protocol handshake fingerprint — survives renames; port must be found first | L0 port move; full stealth is S2 — no AUTH reply (`references/frida-server-mods.md`) |
| `ps -A` / `/proc/<pid>/cmdline` process-name scan (`frida-server`, `frida-helper`, `frida-launcher`) | daemon process scan | L0 rename: `comm` comes from the exec filename (15-byte truncation), `cmdline` from `argv[0]` (overridable via `exec -a`) |

## Probing the environment

| Observable | Vector | Countermeasure class |
|---|---|---|
| `pthread_create` spawning the detection thread (attr/arg both NULL is the upstream heuristic) | watchdog thread spawn | L2: return `-1` from `pthread_create` for that shape — blocks the thread before it exists (upstream `AntiFrida_Bypass` script, blunt but cheap) |
| new threads appearing after a baseline (gum's QuickJS event-loop thread) | thread-set baseline diff | L0 rename helps; hiding a new thread entirely needs S2 (`references/frida-server-mods.md`) |
| exported symbol scan in loaded modules (`frida_agent_main`) | symbol scan | L0: renamed server binary helps; symbol hiding is build-level |
| named pipes/files under `/data/local/tmp/` | runtime artifacts | L1: string sanitize replaces the path |
| `__system_property_get` on emulator/debug markers (`ro.debuggable`, `ro.secure`, `ro.build.type`, `ro.boot.verifiedbootstate`, ...) — and the **earliest detection point** when the module makes that read from its `.init_proc`, i.e. before `.init_array` and long before `JNI_OnLoad` | environment check | observe; forge only if it gates the kill branch. The same call doubles as the earliest *hook* anchor: `android_dlopen_ext` **onEnter** names the module, and the first property read from it proves the module is mapped *and still initializing* — that is the patch window (the `anchor` sensor in `scripts/detect.js`; patching at that window: `ANCHOR` in `scripts/bypass-apply-located.js`). Scoping caveat: this is a global libc hook, so scope/disable it once the base is pinned — a fast hook-integrity layer sees it |
| Java root probes: `Runtime.exec(new String[]{"which","su"})` — **array form**, `cmds[0]` is `which` so a first-element blacklist waves it through; `File.exists`, `Build.TAGS`, `PackageManager.getPackageInfo`, and a native `fopen`-based exists check (`libtoolChecker` RootBeer) | root/environment detection outside the frida vectors — the two easy misses are the array element beyond `cmds[0]` and `fopen` where you hooked `stat`/`access` | cover **every element** across all 4 `Runtime.exec` overloads + `ProcessBuilder.start()`; add `fopen` (root paths → NULL) to the native spoof layer |

## Linker and module state

| Observable | Vector | Countermeasure class |
|---|---|---|
| `dl_iterate_phdr` walk over loaded ELFs, filtering frida SOs | linker-state scan | wrap the callback argument, return 0 for frida names — `bypass-dl-iterate-phdr-filter.js` (keep the `NativeCallback` alive, Rule 6). Nuance: classic ptrace+dlopen injection leaves a `dlpi_name`; **Frida 12+ linjector loads the agent with its own linker — visible in maps but absent from `dlpi_name`** |
| `Process.enumerateModules`-equivalent native walk | same as above | same wrap, or L2 on the walker entry |
| linker **`solist` traversal** (the `soinfo` linked list, reached via `__dl_` globals / xrefs) — the agent is found among loaded modules with no filesystem read at all | module-list scan that **no `/proc` sanitizer can touch** | counter at the walker: patch the detection function entry to `return 0` (L2/L3 — evidence chain + Rule 5 version-pinning). The find ⇒ kill step is a **poisoned-pointer deref** on the matched entry (a fake/cleared field), so the death is a deliberate SIGSEGV raised inside the guard |

## Self-integrity and control flow

| Observable | Vector | Countermeasure class |
|---|---|---|
| CRC32/checksum over own `.text` vs a stored value (e.g. magic `==203`), or disk-SO hash vs in-memory hash at base | self-verification (also catches software breakpoints `0xCC`) | prefer L1/L2 on inputs; when a `.text` write is unavoidable, patch the *checker* and leave the checked region untouched |
| code pages scanned for the Frida trampoline signature `50 00 00 58` (`LDR X16,#8`) — inline hooks replace a function's first 16 bytes | inline-hook detection by signature | avoid inline hooks in scanned regions: hook neighbors, or use hardware breakpoints (traceless, but ARM64 has only 4–6 slots) |
| `ptrace(PTRACE_TRACEME)` self-attach in `.init_array`/`JNI_OnLoad`, failure ⇒ kill | ptrace occupancy | the check is `ptrace` returning -1 — forge its return (`onLeave` → 0) |
| kill paths issued as **direct syscalls** (`MOV X8, #0x5E; SVC #0` = exit_group, bypassing libc) | libc `kill`/`exit` hooks never fire | locate with a syscall filter (seccomp-bpf tracer); patch the SVC site — the filter's reported `pc` is the instruction *after* the SVC: **patch at `pc - 4`** |
| return-address signature check: the caller's return slot must carry a magic string (e.g. `__b_a_n_g_c_l_e__check_env`) | frida's forced jumps break the expected signature chain | locate the verifier, patch its branch |
| polling thread re-running checks on an interval | persistent watchdog | L2: RET-patch the poller entry (evidence chain first) |
| `raise(SIGTRAP)` (or SIGSEGV/SIGBUS "PinkPanic" variants) during load, then the handler-cleared flag is re-read | signal self-check | L2: neutralize at `raise` — forge the flag, zero the signal number |
| hardware breakpoints / inline hooks *inside the security library's own `.text*` | fast-layer hook detection | never hook inside the guarded library; hook its neighbors instead (native SSL in conscrypt, for example) |
| Java/ART-layer hook detection (ART method entry guards; a critical method suddenly reading as `native` is itself the tell) | fast layer watching the managed side | stay native-only: plain `Interceptor.attach` on other libraries does not trip it |
| hook-feature detection on a *specific* function you used to hook (e.g. `pthread_create`): the defense checks whether the standard bypass target is hooked and reacts | countermeasure-targeting — the defense watches the standard bypass target | hook a **lifecycle-downstream function**: `pthread_create` is a wrapper over `clone`, so hook `clone` and drop the detection thread there (`references/methodology.md` §choosing the bypass point) |
| **active counterattack**: signals sent to the frida-server process / agent worker (`anti_thread_of_process_debug`), or `mprotect(PROT_NONE)` on agent code pages from a dlopen-wrapper chain | the defense kills the *agent*, not the app — `Process terminated` while `pidof` still shows the process | disable the dispatcher at its entry (`run_secsdk` → return 0) or patch the chain's **call sites** |
| detection writes a signal file / static field; a stub Application or a 30 s rescanning service pops the warning much later | **decoupled feedback** — the popup's Java stack shows nothing native; a "win" can pop again 30 s later | read the launch stack of the popup Activity and walk back to the checker that armed it |

## Feature classes — what the trace must end on

The trace closes when the exact feature the detector matched is named: the bypass rung is chosen from the class. `featureMatch` in `scripts/detect.js` prints each of these against the live process, so the last detector frame in the Stalker/exception log reads as "it matched *this* class".

| Class | Matchable observable | Confirmed by |
|---|---|---|
| anonymous exec mapping | `r-x` range with no backing file — Frida 16+ loads the agent from `memfd_create`, so the maps entry is anonymous; `readlink /proc/self/map_files/<start>-<end>` often still names it (`/memfd:frida-agent-64.so (deleted)`); Android 10+ anonymizes the fd, so the fd scan dies before the maps scan does | `detect.js` `featureMatch` §A |
| signature string | `frida`, `gum-js-loop`, `gum-log-file`, `linjector-`, `GumScript`, `gumjs-runtime` inside a mapped range — the detector's own `Memory.scan` pattern; rusda's XOR rename removes the server-side strings, not the agent's in-memory copies | `detect.js` `featureMatch` §B |
| ELF vs maps | a PT_LOAD segment the header claims is absent from (or wrong-prot in) the live map — the header-vs-maps consistency check; a consistent but *anonymous* image is caught by class 1 instead | `detect.js` `featureMatch` §C |
| thread name | `gum-js-loop`, `gmain`, `pool-frida` in task `comm` (rusda renames these; an app-created poller keeps the SDK's own name) | `detect.js` `featureMatch` §D |
| fd / port | `linjector-*.sock`, `memfd:frida` fds, LISTEN on 27042/27043 — the classes that survive a fully anonymous agent | `detect.js` `featureMatch` §E |
| unmapped address | an address the target believes mapped (from its own scan) faults on access: either the defense unmapped Frida's page first, or the page was never backed — the fault shape names which | `detect.js` `exceptionHunt` (`frida-mapping-yanked` / `detector-probe`) |

## Timing (why hooks "never fire")

Java-surface note: when detection pops an exit dialog, forcing `AlertDialog.show` to set the dialog cancelable (upstream script A1-01) keeps the session alive long enough to observe (diagnostic aid; the bypass still needs the loop).

When detection runs from `.init`/`.init_array`, an `android_dlopen_ext` **onLeave** hook arrives after the init chain already executed. Re-anchor early (the `anchor` sensor in `scripts/detect.js`, `early-import` mode; or its linker-level `call-constructors` mode, which intercepts `__dl__ZN6soinfo17call_constructorsEv` — the earliest point where the target module is visible and its constructors have not run; patch at that window via `ANCHOR` in `scripts/bypass-apply-located.js`).

**Ordering (why an `.init_proc` anchor is early enough):** `android_dlopen_ext` **onEnter** (name known) → relocations → `.init_proc` (the module's early imports run — `__system_property_get`, `getpid`, `time`) → `.init_array` entries (the detection) → `JNI_OnLoad`. So take the base on the **first early-import call made by that module**: at that instant it is mapped, its own `.init_proc` is executing, and the `.init_array` detectors have not been reached — a NOP written there lands in front of the detection. `onLeave` is already past `.init_array`; wrapping `call_constructors` is earlier still but the import table is only guaranteed usable from inside the constructor, so it is the fallback anchor. The anchor is itself a detection point in the other direction: a global `__system_property_get` hook is a hook-integrity target, so keep it scoped and stop relying on it once the base is pinned. The inverse case also exists and is the **golden window**: when `.init_array` holds only compiler ctors and the detection runs inside `JNI_OnLoad`, the `android_dlopen_ext` **onLeave** lands exactly between the two — base known, constructors done, `JNI_OnLoad` not yet called — the one safe patch moment; verify the original bytes at every patch site before writing, so a version bump fails at the verify step. A related timing weapon: apps whose security stack arms only after the privacy-consent tap admit a **consent-page clean window** — attach (`-N`) at the consent screen, arm hooks, then tap agree. Symptom signature: everything works with `frida -f` spawn+resume under a renamed server, but attach-mode dies, or vice versa.

Load chain for reference (AOSP): `System.loadLibrary()` → `Runtime.loadLibrary0()` → `Runtime.nativeLoad()` → `JavaVMExt::LoadNativeLibrary()` → `android_dlopen_ext` → linker `find_library` (map + relocate) → `si->CallConstructors()` → `.init`/`.init_array` → `JNI_OnLoad`. The window between mapping and constructor execution is also the best moment to dump a packed SO (code already decrypted, not yet re-hidden).

## Field-observed realities (distilled)

- **A maps scanner can be whitelist-shaped**: it kills because *no line matched the whitelist*. The counter is to make the scanner conclude "nothing found": patch its entry to `return 0`.
- **Sanitize with identical byte length.** Callers of a maps buffer observe field positions (`sscanf`-style), the `fread` return count and the `\n` count — pad replacements with spaces so the line length stays identical.
- **Cover every read path the observe-only pass showed.** `fopen` + `fgets` blanking, `strstr` → NULL, `readlink` rewrite, `open` → forged-copy redirect and `faccessat`/`stat`/`access` spoofing each cover different readers of the same file; combine them.
- **Scanners sweep port ranges.** Moving the server off 27042/27043 answers the default-port probes; a sweep past a range needs handling at `connect`.
- **Hook-install detection exists.** A fast layer can trigger on the mere act of installing a hook (independent of whether the callback ever runs — a "quiet" run dies faster), and on plain store instructions overwriting agent memory with no syscall to observe. Exclude hook installation everywhere; stay native-only.
- **Constructor-time solist walks**: a constructor can `strstr` loaded-module names against the solver's own `soinfo` list; patch the walker to `return 0`. `soinfo` list offsets vary by Android version — re-locate per OS. Because the guard never reads `/proc`, maps/proc sanitizers are irrelevant to it, and the find ⇒ kill step is usually a **poisoned-pointer deref** — a deliberate SIGSEGV raised inside the guard — so exit-path hooks see nothing and the process dies as a crash. `return 0` at the detection function entry removes traversal, deref and verdict together.
- **Signal self-checks detect interception.** Break them at `raise` (forge the handler-cleared flag to 0, zero the signal number). Global signal masking and handler-side fixes both leave the check intact.
- **Inline syscalls are unobservable to libc hooks** — classify by capability (see methodology, capability exclusion) before blaming a module whose hooks never fired.
