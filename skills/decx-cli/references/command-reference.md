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
- Session-backed `decx code` and `decx ard` commands accept `-P <port>` or `-s <name>`.
- adb-backed `decx ard` commands such as `system-services` and `perm-info` do not use `-P <port>`.
- When only one session is alive and `-P` is not specified, the CLI auto-selects it.
- `-s, --session <name>` selects a session by name as an alternative to `-P <port>`.
- `process list` does not take `-P <port>`.
- `process close` can close by name, by `--port <port>`, or all sessions with `--all`.
- `process status` checks a named session, a specific `--port`, or the configured default port. Do not pass both a name and `--port`.
- `ard framework collect/process/run/open` expose common framework options. For `open`, adb options are only used when resolving the generated jar path without an explicit `[jar]`.
- Supported framework OEM values are `vivo`, `oppo`, `xiaomi`, `honor`, `google`, and `samsung`.
- If command name, flags, arguments, or port behavior are uncertain, run the nearest `--help` command first. Do not guess DECX syntax.
- Quote identifiers and pass them in the exact format below; malformed identifiers waste analysis time and may query the wrong target.

## Session Commands

| Command | Purpose |
|--------|---------|
| `decx process check [-P <port>]` | Check DECX environment and runtime readiness |
| `decx process open "<file-or-url>" [-P <port>]` | Open a target for analysis |
| `decx process status` | Check the configured default server port |
| `decx process status "<name>"` | Check one named session |
| `decx process status -P <port>` | Check one server port |
| `decx process list` | List active sessions |
| `decx process close "[name]"` | Close one session |
| `decx process close --port <port>` | Close the session on one port |
| `decx process close --all` | Close all sessions |

Open options:

```text
-P, --port <port>     preferred server port; if unavailable, DECX chooses a random available port
-n, --name <name>     explicit session name
--mcp                 also start MCP Streamable HTTP server on port + 1
--force               reopen despite a conflicting session
```

`process open` always starts `decx-server.jar` with JVM `-Xmx` set to two thirds of machine memory, rounded down. There is no CLI heap override.
It accepts local paths and `http(s)://` URLs. URLs are downloaded into DECX tmp storage before the server starts.
Standard JADX args after `process open` are forwarded with DECX defaults: `--deobf` is removed, and `--show-bad-code`, `--no-imports`, and `-Pdex-input.verify-checksum=no` are added when absent.

Conflict behavior:

- same name + same hash + alive process: DECX reuses the session
- same name + different hash: DECX errors unless `--force` or a new `--name` is used
- different name + same hash: DECX errors unless `--force` is used

## Code Commands

All `code` commands support `-s, --session <name>` as an alternative to `-P <port>`.

| Command | Purpose |
|--------|---------|
| `decx code classes -P <port>` | List classes (`--limit`, `--include-package`, `--exclude-package`, `--no-regex`) |
| `decx code class-context "<class>" -P <port>` | Show fields and methods |
| `decx code class-source "<class>" -P <port>` | Show class source (`--limit`, `--smali`) |
| `decx code method-context "<signature>" -P <port>` | Show method signature, callers, and callees |
| `decx code method-source "<signature>" -P <port>` | Show method source (`--smali`) |
| `decx code method-cfg "<signature>" -P <port>` | Show method control flow graph as DOT |
| `decx code xref-method "<signature>" -P <port>` | Show method callers |
| `decx code xref-class "<class>" -P <port>` | Show class references |
| `decx code xref-field "<field>" -P <port>` | Show field reads and writes |
| `decx code implement "<interface>" -P <port>` | List interface implementations |
| `decx code subclass "<class>" -P <port>` | List subclasses |
| `decx code search-global "<keyword>" -P <port>` | Search class names and decompiled class bodies (`--limit`, `--include-package`, `--exclude-package`, `--case-sensitive`, `--no-regex`) |
| `decx code search-class "<class>" "<keyword>" -P <port>` | Grep one class (`--limit` required, `--case-sensitive`, `--no-regex`) |
| `decx code search-method "<name>" -P <port>` | Search method names |

## Android Commands

All session-backed `ard` commands support `-s, --session <name>` as an alternative to `-P <port>`.

| Command | Purpose |
|--------|---------|
| `decx ard app-manifest -P <port>` | Read `AndroidManifest.xml` |
| `decx ard main-activity -P <port>` | Show main activity |
| `decx ard app-application -P <port>` | Show application class |
| `decx ard exported-components -P <port>` | List exported components (`--type`, `--exclude-type`, `--no-regex`) |
| `decx ard app-deeplinks -P <port>` | List deep links |
| `decx ard app-receivers -P <port>` | List dynamic receivers (`--limit`, `--include-package`, `--exclude-package`, `--no-regex`) |
| `decx ard get-aidl -P <port>` | List AIDL interfaces (`--limit`, `--include-package`, `--exclude-package`, `--no-regex`) |
| `decx ard system-service-impl "<interface>" -P <port>` | Resolve framework service implementation |
| `decx ard system-services --serial <serial> [--grep <keyword>]` | List live Binder/system services as JSON |
| `decx ard perm-info "<permission>" --serial <serial>` | Resolve one permission as JSON |
| `decx ard all-resources -P <port>` | List resource file names (`--include`, `--no-regex`) |
| `decx ard resource-file "<res>" -P <port>` | Read one resource file |
| `decx ard strings -P <port>` | Read `strings.xml` |

For `system-services`, consume `services[].name` and `services[].interfaces` from parsed JSON. For `perm-info`, reason from fields such as `permission`, `package`, `description`, and `protectionLevel`.

## Framework Commands

| Command | Purpose |
|--------|---------|
| `decx ard framework collect --serial <serial>` | Pull framework files from a connected device |
| `decx ard framework process <oem>` | Process local framework source and pack `framework_<brand>_<vendor>.jar` |
| `decx ard framework run --serial <serial> [-P <port>]` | Collect, process, pack, and open the generated framework jar |
| `decx ard framework open -P <port>` | Open the generated framework jar |
| `decx ard framework open "<jar>" -P <port>` | Open a provided framework jar |

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
-P, --port <port>     server port when opening
```

`framework process` takes only `<oem>` as a positional argument. Supported values are `vivo`, `oppo`, `xiaomi`, `honor`, `google`, and `samsung`. Do not pass a source directory as a positional argument.

`framework open` takes optional `[jar]`, `-P <port>`, and `-n <name>`.

## Self Commands

| Command | Purpose |
|--------|---------|
| `decx self install` | Install `decx-server.jar` |
| `decx self install -p` | Install prerelease server |
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
decx code search-method "onCreate" -P <port>
decx code method-source "<exact returned signature>" -P <port>
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
decx code method-source "<signature>" -P <port>
decx code method-source "<signature>" -s <session-name>
decx ard app-manifest -P <port>
decx ard system-services --serial <serial> --grep "<keyword>"
decx ard perm-info "<permission>" --serial <serial>
decx ard framework process <oem> --source-dir "<dir>" --out-dir "<dir>"
decx ard framework open "<framework-jar>" -P <port>
```

Do not mix session and adb argument styles:

- `decx code *` -> always session-backed, needs `-P <port>` or `-s <name>`
- `decx ard app-*`, `exported-components`, `resource-file`, `system-service-impl`, `strings`, `all-resources` -> session-backed, needs `-P <port>` or `-s <name>`
- `decx ard system-services`, `perm-info` -> adb-backed, no `-P <port>`
- `decx ard framework collect`, `process` -> adb-backed (no `-P`)
- `decx ard framework run` -> hybrid: adb for collect, `-P` for open
- `decx ard framework open` -> session-backed after jar resolution; adb options only affect generated-jar resolution when `[jar]` is omitted

## Common Patterns

Understand app structure:

```bash
decx ard app-manifest -P <port>
decx ard exported-components -P <port>
decx ard app-deeplinks -P <port>
decx code classes -P <port>
```

Trace a feature:

```bash
decx code search-method "login" -P <port>
decx code class-source "com.example.AuthManager" --limit 120 -P <port>
decx code xref-method "com.example.AuthManager.login(java.lang.String,java.lang.String):boolean" -P <port>
```

Inspect inheritance and resources:

```bash
decx code subclass "com.example.BaseActivity" -P <port>
decx code implement "com.example.MyInterface" -P <port>
decx ard all-resources --include "res/xml" -P <port>
decx ard resource-file "res/xml/file_paths.xml" -P <port>
```
