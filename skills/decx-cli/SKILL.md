---
name: decx-cli
description: Use when running DECX CLI commands to open APK, DEX, JAR, or framework targets; inspect classes, methods, source, xrefs, inheritance, or search results; inspect manifests, components, resources, AIDL, Binder metadata, or permissions for Android targets; or manage DECX sessions.
metadata:
  requires:
    bins: ["decx"]
---

# DECX CLI

Core DECX skill: runs `decx` CLI commands for Android/Java target analysis. Targets include APK, DEX, JAR, and processed framework files. 

## Command Selection

Use this skill for DECX CLI command usage and session management. Do not use it for vulnerability methodology (-> `decx-vulnhunt`), reports (-> `decx-report`), or PoC construction (-> `decx-poc`).

| Need | Command |
|---|---|
| open / reuse / close a target | `decx session` |
| discover modules and their install state | `decx module list` |
| classes, methods, source, xrefs, inheritance, search | `decx -m jadx` |
| manifest, components, deep links, resources, AIDL, framework services (Android only) | `decx -m jadx` |
| live Binder services or permissions from a device (Android only) | `decx -m ard-framework device system-services` / `decx -m ard-framework device permission-info` — no DECX `--port` |
| install or update DECX runtime | `decx install` / `decx self update` |

Every server and plugin is a module; commands run through the module selected
for the invocation with `-m/--module` (`decx -m <module> <command>`). `decx -m
<module>` alone prints that module's command list, and `decx module list`
lists every discovered module.

Running `decx` with no arguments prints the same top-level help as `decx --help`.

## Session Management

Reuse an active session when it matches the target. Keep one session per target.

```bash
decx session list
decx session open "<target>" --engine jadx --name "<target-name>" --port <port>
decx session check "<target-name>"
decx session close "<target-name>"
decx session close --all
```

## Argument Rules

- Session-backed module commands (`decx -m jadx …`, `decx -m asc …`, `decx -m kuna …`) accept `--session <name>` or `--port <port>`. When exactly one healthy compatible session is running, omit both to auto-select it; with several sessions the call errors (`multiple compatible sessions; select one with --session`) and with none it errors (`no healthy compatible session; use session open or session check`) — there is no silent default-port fallback, so pass one explicitly when more than one session is alive.
- adb-backed `decx -m ard-framework device system-services` and `decx -m ard-framework device permission-info` never take DECX `--port`; use `--serial` for device selection.
- Quote all identifiers: class names, method signatures, field identifiers, resource paths, package names, interface names. Strings containing `$`, `(`, `)`, `:`, or `*` are parsed by the shell and either error or target the wrong symbol; always wrap in double quotes and never rely on escaping.
- Method signatures: use the exact signature returned by `decx -m jadx search-method` or context/search results. A shortened signature such as `"Class.method"` or `"Class.method():void"` returns the wrong method, an empty body, or a stale cached match. First run `decx -m jadx search-method "<name>"`, then copy the exact returned signature into `method-source`, `method-context`, `method-cfg`, or `xref-method`. Never use shortened signatures, partial class names, placeholders, or `...`.

## Navigation

Open targets first, then inspect. Use search when the class, method, component, or resource name is unknown.

```bash
# Android metadata
decx -m jadx manifest --port <port>
decx -m jadx exported-components --port <port>
decx -m jadx deep-links --port <port>
decx -m jadx aidl-interfaces --port <port>

# Code inspection
decx -m jadx class-context "<class>" --port <port>
decx -m jadx class-source "<class>" --port <port>
decx -m jadx method-context "<signature>" --port <port>
decx -m jadx method-source "<signature>" --port <port>
decx -m jadx search-global "<keyword>" --limit <n> --port <port>
```

## Persistence

Keep notes and outputs for work that may continue later in the working directory. Close the session only when the target is no longer needed.

## Troubleshooting

| Symptom | Action |
|---|---|
| command missing, rejected, or uncertain | run nearest `--help` before retrying |
| target/name conflict on `session open` | use `--force`; a new `--name` only resolves a pure name collision, not a same-target conflict |
| `--force` / `session close` errors with "PID <pid> has not stopped; session retained" | the old JVM survived the kill; kill that pid manually, then retry the same command — the session record is kept on purpose |
| unsupported framework OEM | supported values are `vivo`, `oppo`, `xiaomi`, `honor`, `google`, `samsung` |
| `decx -m ard-framework framework process` on Windows fails with "has no native Windows binary" | the plugin parses ext4/EROFS payload images natively in JavaScript, so standard payloads work on any platform; only unsupported payload features need `debugfs`/`erofs-utils` from PATH, which are Linux/macOS-only — run `framework process` there |
| need exact command syntax | read `references/command-reference.md` |

## Gotchas

Concrete failure modes from real sessions. These are not generic CLI tips; they are conditions where the wrong call silently corrupts analysis or returns plausible-but-wrong output.

- **`--port` on adb-backed commands**: `decx -m ard-framework device system-services` and `decx -m ard-framework device permission-info` talk to adb, not the DECX HTTP server, and register no `--port`. Written before the leaf subcommand it fails with an unknown-command error; written after it, with `unknown option --port`. Never pass `--port`; use `--serial` for device selection.
- **`decx -m jadx search-global` without `--limit`**: without `--limit` the server returns all matches, potentially hundreds, which burns context and frequently hides the actual hit. Always set `--limit` to a small working set (start at 20-50) and refine.
- **`session open` reuse is identity-first**: an alive session with the same file hash, engine, scripts, and trailing server arguments is reused when `--name`/`--port` are omitted or repeated unchanged. Requesting a different `--name` or `--port` for that same identity conflicts and errors until `--force` is passed or the session is closed.
- **`session open --script` is part of the reuse identity**: scripts run at decompile time, so the same file with a different `--script` set than the alive session errors until `--force`. Reopening with the same scripts (and no conflicting `--name`/`--port`) reuses the session.
- **`session open` heartbeat on stderr is normal**: while waiting for server health, progress lines (`Waiting for <name> (<s>s); log: <log>`) appear on stderr roughly every 15s; stdout stays JSON-only. `--timeout <seconds>` (default 300) bounds the wait; on timeout with the JVM alive the session is kept — follow up with `session check` / `session close`.
- **hierarchy results may include two spellings of one hit**: `implementations` / `subclasses` attribute nested (inner / inlined lambda `$$ExternalSyntheticLambda*`) declarations to the outer class, and the synthetic class also appears as its own entry. Treat both as hits; do not deduplicate into a false negative.
- **`decx -m jadx deep-links` / `dynamic-receivers` on a non-app target**: `decx -m jadx deep-links` returns a MANIFEST_NOT_FOUND error on targets without a manifest; `dynamic-receivers` is a code search and may return plausible-looking matches with no app semantics on a framework jar. For framework targets, use `decx -m jadx aidl-interfaces` and `decx -m jadx framework-service-implementation`.

## References

- `references/command-reference.md`
