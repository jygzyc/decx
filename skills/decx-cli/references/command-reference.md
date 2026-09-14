# DECX CLI Command Reference

## Contents

- [Command Rules](#command-rules)
- [Session Commands](#session-commands)
- [Code Commands](#code-commands)
- [Android Commands](#android-commands)
- [Framework Commands](#framework-commands)
- [Self Commands](#self-commands)
- [Identifier Formats](#identifier-formats)
- [Common Patterns](#common-patterns)

## Command Rules

- Running `decx` with no arguments prints the same top-level help as `decx --help`.
- Session-backed module commands (`decx -m jadx …`, `decx -m asc …`, `decx -m kuna …`) accept `--session <name>` or `--port <port>`.
- adb-backed `decx -m ard-framework device` commands such as `system-services` and `permission-info` do not use `--port <port>` and register no such flag.
- When only one healthy compatible session is running and neither `--session` nor `--port` is specified, the CLI auto-selects it; with several sessions it errors (`multiple compatible sessions; select one with --session`) and with none it errors (`no healthy compatible session; use session open or session check`).
- `--session <name>` selects a session by name as an alternative to `--port <port>`.
- All session-backed commands also accept `--page <n>` for pagination.
- `session list` does not take `--port <port>`.
- `session close` can close by name, by `--port <port>`, or all sessions with `--all`; a failed kill keeps the session record and errors with the pid — the still-running JVM stays tracked, never orphaned.
- `session check` lists sessions with their health state; given a name, it shows that one session. It takes no `--port`.
- `decx -m ard-framework framework collect/process` expose common framework options. The plugin only collects, processes and packs; the packed jar is opened with `decx session open`.
- Supported framework OEM values are `vivo`, `oppo`, `xiaomi`, `honor`, `google`, and `samsung`.
- If command name, flags, arguments, or port behavior are uncertain, run the nearest `--help` command first. Do not guess DECX syntax.
- Quote identifiers and pass them in the exact format below; malformed identifiers waste analysis time and may query the wrong target.

## Session Commands

| Command | Purpose |
|--------|---------|
| `decx session open "<target>" [--module <id>] [--name <name>] [--port <port>] [--timeout <seconds>] [--script <file>] [--force]` | Open a target for analysis |
| `decx session list` | List recorded sessions with their state |
| `decx session check` | List sessions with their health state |
| `decx session check "<name>"` | Show one named session |
| `decx session close "<name>"` | Close one session by name |
| `decx session close --port <port>` | Close the session on one port |
| `decx session close --all` | Close all sessions |

Open options:

```text
--module <id>         server module to launch; defaults to the module marked as default (`decx module list` shows the ids)
--port <port>         explicit server port; the open fails when it is unavailable (without --port, DECX picks a free port in 30000-40000)
--name <name>         explicit session name
--force               replace conflicting sessions (same name or same file hash): their JVMs are killed and death-verified before the new server starts
--timeout <seconds>   seconds to wait for server health (default 300)
--script <file>       Jadx Kotlin script (.jadx.kts) run during decompilation; repeatable
-- <server arguments> trailing engine arguments forwarded to the server (for `jadx`, standard JADX args)
```

`session open` starts the engine's launch command (for `jadx`: `java -jar jadx-server.jar <target> --port <port>`), so the JVM heap follows the system default — there is no CLI heap override.
The target must be a regular local file; it is hashed as part of the session identity, and no URL download is performed.
Standard JADX args must follow `--` and are normalized inside `jadx-server`: `--deobf` is removed, and `--show-bad-code`, `--no-imports`, and `-Pdex-input.verify-checksum=no` are added when absent.
`--script` files are positional inputs to `jadx-server` and are evaluated by the bundled `jadx-script-kotlin` plugin during decompilation (top-level code at load, `jadx.afterLoad { }` blocks after classes load).

Startup behavior:

- while waiting for server health, `session open` prints a heartbeat to stderr roughly every 15s (`Waiting for <name> (<s>s); log: <log-path>`); stdout stays JSON-only — heartbeat lines are progress, not errors
- `--force` kills the JVMs of the alive sessions it replaces and verifies death; if a kill fails, DECX aborts the spawn, keeps the old session record, and names the pid to kill manually — retry the same command after killing it
- on `--timeout` with the JVM still alive, the session record is kept (follow up with `session check` / `session close`); the record is removed only when the JVM exited

Reuse and conflict behavior:

- same session identity (file hash, engine, engine binary, script set, trailing server arguments) with no conflicting requested `--name`/`--port`: DECX reuses the alive session
- same file hash and engine but a different script set or trailing arguments: DECX errors unless `--force` is used (scripts run at decompile time, so they are part of the session identity)
- requested `--name` already used by an alive session for another target: DECX errors unless `--force` or a different `--name` is used
- stale record whose process is gone: DECX replaces the record and starts a new session
- `--force`: DECX kills the alive sessions matching the same name or the same file hash and engine (verified kill), then starts a new session; a failed kill aborts the spawn and leaves the old session intact

## Code Commands

All code commands are `decx -m jadx …` and support `--session <name>` as an alternative to `--port <port>`.

| Command | Purpose |
|--------|---------|
| `decx -m jadx classes --port <port>` | List classes (`--limit`, `--include-package`, `--exclude-package`, `--no-regex`) |
| `decx -m jadx class-context "<class>" --port <port>` | Show fields and methods |
| `decx -m jadx class-source "<class>" --port <port>` | Show class source (`--limit`, `--smali`) |
| `decx -m jadx method-context "<signature>" --port <port>` | Show method signature, callers, and callees |
| `decx -m jadx method-source "<signature>" --port <port>` | Show method source (`--smali`) |
| `decx -m jadx method-cfg "<signature>" --port <port>` | Show method control flow graph as DOT |
| `decx -m jadx xref-method "<signature>" --port <port>` | Show method callers |
| `decx -m jadx xref-class "<class>" --port <port>` | Show class references |
| `decx -m jadx xref-field "<field>" --port <port>` | Show field reads and writes |
| `decx -m jadx implementations "<interface>" --port <port>` | List interface implementations |
| `decx -m jadx subclasses "<class>" --port <port>` | List subclasses |
| `decx -m jadx search-global "<keyword>" --port <port>` | Search class names and decompiled class bodies (`--limit`, `--include-package`, `--exclude-package`, `--case-sensitive`, `--no-regex`) |
| `decx -m jadx search-class "<class>" "<keyword>" --port <port>` | Grep one class (`--limit` required, `--case-sensitive`, `--no-regex`) |
| `decx -m jadx search-method "<name>" --port <port>` | Search method names |

Hierarchy semantics (`implementations`, `subclasses`, `aidl-interfaces`, `framework-service-implementation`): results match direct dex declarations, and declarations made by nested classes (inner, anonymous, or inlined `$$ExternalSyntheticLambda*`) are attributed to the outer class as well. Both spellings are real hits: an outer class listed because an inlined lambda implements the interface, plus the synthetic class as its own entry.

## Android Commands

All session-backed `decx -m jadx` commands support `--session <name>` as an alternative to `--port <port>`.

| Command | Purpose |
|--------|---------|
| `decx -m jadx manifest --port <port>` | Read `AndroidManifest.xml` |
| `decx -m jadx launcher-activity --port <port>` | Show main activity |
| `decx -m jadx application --port <port>` | Show application class |
| `decx -m jadx exported-components --port <port>` | List exported components (`--type`, `--exclude-type`, `--no-regex`) |
| `decx -m jadx deep-links --port <port>` | List deep links |
| `decx -m jadx dynamic-receivers --port <port>` | List dynamic receivers (`--limit`, `--include-package`, `--exclude-package`, `--no-regex`) |
| `decx -m jadx aidl-interfaces --port <port>` | List AIDL interfaces (`--limit`, `--include-package`, `--exclude-package`, `--no-regex`) |
| `decx -m jadx framework-service-implementation "<interface>" --port <port>` | Resolve framework service implementation |
| `decx -m ard-framework device system-services [--serial <serial>] [--adb-path <path>] [--grep <keyword>]` | List live Binder/system services as JSON |
| `decx -m ard-framework device permission-info "<permission>" [--serial <serial>] [--adb-path <path>]` | Resolve one permission as JSON |
| `decx -m jadx resources --port <port>` | List resource file names (`--include`, `--no-regex`) |
| `decx -m jadx resource-file "<res>" --port <port>` | Read one resource file |
| `decx -m jadx strings --port <port>` | Read `strings.xml` |

For `system-services`, consume `services[].name` and `services[].interfaces` from parsed JSON. For `permission-info`, reason from fields such as `permission`, `package`, `description`, and `protectionLevel`.

## Framework Commands

| Command | Purpose |
|--------|---------|
| `decx -m ard-framework framework collect [--serial <serial>]` | Pull framework files from a connected device |
| `decx -m ard-framework framework process [oem]` | Process local framework source and pack `framework_<brand>_<vendor>.jar` |

Framework common options (`collect`, `process`):

```text
--serial <serial>     adb device serial
--adb-path <path>     adb executable path
--source-dir <dir>    framework source directory
--out-dir <dir>       framework output directory
--clean-source        remove source after successful command
```

`framework process` accepts optional `[oem]` as its only positional argument. When omitted, DECX resolves OEM from `.artifact.json` under `--out-dir`, then falls back to a connected device. Do not pass a source directory as a positional argument.

The packed jar (`data.pack.jarPath`) is opened with `decx session open "<framework-jar>"`; the plugin never starts a session itself.

Platform note: the plugin parses ext4 and EROFS payload images natively in JavaScript, so standard APEX payloads are unpacked on every platform without external tools. Only payload features the native readers do not support fall back to `debugfs`/`extract.erofs`/`fsck.erofs` from `PATH` (`DECX_DEBUGFS`/`DECX_EXTRACT_EROFS`/`DECX_FSCK_EROFS` override); those tools are Linux/macOS-only, and Windows fails for such payloads with an explicit "has no native Windows binary" error. There is no WSL delegation and no packaged binaries.

## Self Commands

| Command | Purpose |
|--------|---------|
| `decx install [--module <id\|repo\|path>]... [--all] [--force] [--prerelease]` | Install modules: every module that declares a release source when nothing is given (the shipped modules all do; `--all` is the explicit form), or the named modules |
| `decx install --module <id\|repo\|path>` | Install one module: a known id refreshed from its release, or a directory/`.zip`/`.tar.gz` or repository (`owner/repo[@ref]`, `github.com/owner/repo`, `https://host/owner/repo`) imported into `$DECX_HOME/modules/<id>` |
| `decx install --prerelease` | Install prerelease artifacts |
| `decx install --cli` | Also replace the `decx` executable with the newest release |
| `decx self skills install --client <client>` | Download skills from GitHub; Codex, Claude Code, and Cursor use dedicated directories, while every other or omitted client uses `~/.agents/skills` |
| `decx self update [--module <id>]... [--all] [--cli] [--force] [--prerelease]` | Update installed modules; `--cli` also replaces the `decx` executable |
| `decx self update --prerelease` | Update with prerelease artifacts |
| `decx module list` | List discovered modules with `id`, `kind`, install state, version and release source |

`--prerelease` installs the newest GitHub prerelease. Prereleases are published only from prerelease tags such as `v4.2.0-rc.1`; when none exists, the install fails with "No prerelease found".

## Identifier Formats

Class name:

```text
"package.Class"
```

Method signature:

```text
Use the exact signature returned by `decx -m jadx search-method`, `class-context`, `method-context`, or `search-class`.
```

Example:

```text
decx -m jadx search-method "onCreate" --port <port>
decx -m jadx method-source "<exact returned signature>" --port <port>
```

Field identifier:

```text
"package.Class.fieldName :type"
```

Interface name:

```text
"package.Interface"
```

Resource path:

```text
"res/xml/file_paths.xml"
```

Port and device arguments:

```text
decx -m jadx method-source "<signature>" --port <port>
decx -m jadx method-source "<signature>" --session <session-name>
decx -m jadx manifest --port <port>
decx -m ard-framework device system-services --serial <serial> --grep "<keyword>"
decx -m ard-framework device permission-info "<permission>" --serial <serial>
decx -m ard-framework framework process [oem] --source-dir "<dir>" --out-dir "<dir>"
decx session open "<framework-jar>"
```

## Common Patterns

Understand app structure:

```bash
decx -m jadx manifest --port <port>
decx -m jadx exported-components --port <port>
decx -m jadx deep-links --port <port>
decx -m jadx classes --port <port>
```

Trace a feature:

```bash
decx -m jadx search-method "login" --port <port>
decx -m jadx class-source "com.example.AuthManager" --limit 120 --port <port>
decx -m jadx xref-method "com.example.AuthManager.login(java.lang.String,java.lang.String):boolean" --port <port>
```

Inspect inheritance and resources:

```bash
decx -m jadx subclasses "com.example.BaseActivity" --port <port>
decx -m jadx implementations "com.example.MyInterface" --port <port>
decx -m jadx resources --include "res/xml" --port <port>
decx -m jadx resource-file "res/xml/file_paths.xml" --port <port>
```
