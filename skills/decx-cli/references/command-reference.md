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
- Session-backed `decx code` and `decx android` commands accept `--port <port>` or `-s <name>`.
- adb-backed `decx android` commands such as `system-services` and `permission-info` do not use `--port <port>`.
- When only one session is alive and neither `--port` nor `-s` is specified, the CLI auto-selects it.
- `-s, --session <name>` selects a session by name as an alternative to `--port <port>`.
- All session-backed commands also accept `--page <n>` for pagination.
- `process list` does not take `--port <port>`.
- `process close` can close by name, by `--port <port>`, or all sessions with `--all`.
- `process status` checks a named session or a specific `--port`; with neither, it auto-selects the only alive session and otherwise checks the configured default port. Do not pass both a name and `--port`.
- `android framework collect/process/run/open` expose common framework options. For `open`, adb options are only used when resolving the generated jar path without an explicit `[jar]`.
- Supported framework OEM values are `vivo`, `oppo`, `xiaomi`, `honor`, `google`, and `samsung`.
- If command name, flags, arguments, or port behavior are uncertain, run the nearest `--help` command first. Do not guess DECX syntax.
- Quote identifiers and pass them in the exact format below; malformed identifiers waste analysis time and may query the wrong target.

## Session Commands

| Command | Purpose |
|--------|---------|
| `decx process check [--port <port>]` | Check DECX environment and runtime readiness |
| `decx process open "<file-or-url>" [--port <port>]` | Open a target for analysis |
| `decx process status` | Check the only alive session, or the configured default port when auto-selection is unavailable |
| `decx process status "<name>"` | Check one named session |
| `decx process status --port <port>` | Check one server port |
| `decx process list` | List active sessions |
| `decx process close "[name]"` | Close one session |
| `decx process close --port <port>` | Close the session on one port |
| `decx process close --all` | Close all sessions |

Open options:

```text
--port <port>     preferred server port; if unavailable, DECX chooses a random available port
-n, --name <name>     explicit session name
--mcp                 also start MCP Streamable HTTP server on port + 1
--force               reopen despite a conflicting session
```

`process open` always starts `decx-server.jar` with JVM `-Xmx` set to two thirds of machine memory, rounded down. There is no CLI heap override.
It accepts local paths and `http(s)://` URLs. URLs are downloaded into DECX tmp storage before the server starts.
Standard JADX args after `process open` are forwarded with DECX defaults: `--deobf` is removed, and `--show-bad-code`, `--no-imports`, and `-Pdex-input.verify-checksum=no` are added when absent.

Reuse and conflict behavior:

- any alive session with the same file hash: DECX must reuse that session, regardless of the requested name
- no matching alive file + requested name belongs to a different file: DECX errors unless `--force` or a new `--name` is used
- stale same-name record for the same file: DECX removes the stale record and starts a new session
- `--force`: DECX skips hash reuse and starts a new session

## Code Commands

All `code` commands support `-s, --session <name>` as an alternative to `--port <port>`.

| Command | Purpose |
|--------|---------|
| `decx code classes --port <port>` | List classes (`--limit`, `--include-package`, `--exclude-package`, `--no-regex`) |
| `decx code class-context "<class>" --port <port>` | Show fields and methods |
| `decx code class-source "<class>" --port <port>` | Show class source (`--limit`, `--smali`) |
| `decx code method-context "<signature>" --port <port>` | Show method signature, callers, and callees |
| `decx code method-source "<signature>" --port <port>` | Show method source (`--smali`) |
| `decx code method-cfg "<signature>" --port <port>` | Show method control flow graph as DOT |
| `decx code xref-method "<signature>" --port <port>` | Show method callers |
| `decx code xref-class "<class>" --port <port>` | Show class references |
| `decx code xref-field "<field>" --port <port>` | Show field reads and writes |
| `decx code implementations "<interface>" --port <port>` | List interface implementations |
| `decx code subclasses "<class>" --port <port>` | List subclasses |
| `decx code search-global "<keyword>" --port <port>` | Search class names and decompiled class bodies (`--limit`, `--include-package`, `--exclude-package`, `--case-sensitive`, `--no-regex`) |
| `decx code search-class "<class>" "<keyword>" --port <port>` | Grep one class (`--limit` required, `--case-sensitive`, `--no-regex`) |
| `decx code search-method "<name>" --port <port>` | Search method names |

## Android Commands

All session-backed `android` commands support `-s, --session <name>` as an alternative to `--port <port>`.

| Command | Purpose |
|--------|---------|
| `decx android manifest --port <port>` | Read `AndroidManifest.xml` |
| `decx android launcher-activity --port <port>` | Show main activity |
| `decx android application --port <port>` | Show application class |
| `decx android exported-components --port <port>` | List exported components (`--type`, `--exclude-type`, `--no-regex`) |
| `decx android deep-links --port <port>` | List deep links |
| `decx android dynamic-receivers --port <port>` | List dynamic receivers (`--limit`, `--include-package`, `--exclude-package`, `--no-regex`) |
| `decx android aidl-interfaces --port <port>` | List AIDL interfaces (`--limit`, `--include-package`, `--exclude-package`, `--no-regex`) |
| `decx android framework-service-implementation "<interface>" --port <port>` | Resolve framework service implementation |
| `decx android device system-services [--serial <serial>] [--adb-path <path>] [--grep <keyword>]` | List live Binder/system services as JSON |
| `decx android device permission-info "<permission>" [--serial <serial>] [--adb-path <path>]` | Resolve one permission as JSON |
| `decx android resources --port <port>` | List resource file names (`--include`, `--no-regex`) |
| `decx android resource-file "<res>" --port <port>` | Read one resource file |
| `decx android strings --port <port>` | Read `strings.xml` |

For `system-services`, consume `services[].name` and `services[].interfaces` from parsed JSON. For `permission-info`, reason from fields such as `permission`, `package`, `description`, and `protectionLevel`.

## Framework Commands

| Command | Purpose |
|--------|---------|
| `decx android framework collect [--serial <serial>]` | Pull framework files from a connected device |
| `decx android framework process [oem]` | Process local framework source and pack `framework_<brand>_<vendor>.jar` |
| `decx android framework run [--serial <serial>] [--port <port>]` | Collect, process, pack, and open the generated framework jar |
| `decx android framework open --port <port>` | Open the generated framework jar |
| `decx android framework open "<jar>" --port <port>` | Open a provided framework jar |

Framework common options (`collect`, `process`, `run`):

```text
--serial <serial>     adb device serial
--adb-path <path>     adb executable path
--source-dir <dir>    framework source directory
--out-dir <dir>       framework output directory
--clean-source        remove source after successful command
```

`framework open` also exposes these common options. Use `--adb-path`, `--serial`, `--source-dir`, and `--out-dir` only when no explicit `[jar]` is provided and the CLI must resolve the generated jar for a connected device or output directory.

`framework run` additional options:

```text
--no-open             do not open the generated jar after packing
-n, --name <name>     session name when opening
--port <port>     server port when opening
```

`framework process` accepts optional `[oem]` as its only positional argument. When omitted, DECX resolves OEM from `.artifact.json` under `--out-dir`, then falls back to a connected device. Do not pass a source directory as a positional argument.

`framework open` takes optional `[jar]`, `--port <port>`, and `-n <name>`.

## Self Commands

| Command | Purpose |
|--------|---------|
| `decx self install` | Install `decx-server.jar` |
| `decx self install -p` | Install prerelease server |
| `decx self skills install -c <client>` | Download skills from GitHub; Codex, Claude Code, and Cursor use dedicated directories, while every other or omitted client uses `~/.agents/skills` |
| `decx self update` | Update CLI and server |
| `decx self update -p` | Update with prerelease server |

## Identifier Formats

Class name:

```text
"package.Class"
```

Method signature:

```text
Use the exact signature returned by `decx code search-method`, `class-context`, `method-context`, or `search-class`.
```

Example:

```text
decx code search-method "onCreate" --port <port>
decx code method-source "<exact returned signature>" --port <port>
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
decx code method-source "<signature>" --port <port>
decx code method-source "<signature>" -s <session-name>
decx android manifest --port <port>
decx android device system-services --serial <serial> --grep "<keyword>"
decx android device permission-info "<permission>" --serial <serial>
decx android framework process [oem] --source-dir "<dir>" --out-dir "<dir>"
decx android framework open "<framework-jar>" --port <port>
```

## Common Patterns

Understand app structure:

```bash
decx android manifest --port <port>
decx android exported-components --port <port>
decx android deep-links --port <port>
decx code classes --port <port>
```

Trace a feature:

```bash
decx code search-method "login" --port <port>
decx code class-source "com.example.AuthManager" --limit 120 --port <port>
decx code xref-method "com.example.AuthManager.login(java.lang.String,java.lang.String):boolean" --port <port>
```

Inspect inheritance and resources:

```bash
decx code subclasses "com.example.BaseActivity" --port <port>
decx code implementations "com.example.MyInterface" --port <port>
decx android resources --include "res/xml" --port <port>
decx android resource-file "res/xml/file_paths.xml" --port <port>
```
