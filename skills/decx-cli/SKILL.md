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
| open / reuse / close a target | `decx process` |
| classes, methods, source, xrefs, inheritance, search | `decx code` |
| manifest, components, deep links, resources, AIDL, framework services (Android only) | `decx android` with `--port <port>` |
| live Binder services or permissions from a device (Android only) | `decx android device system-services` / `decx android device permission-info` — no DECX `--port` |
| install or update DECX runtime | `decx self` |

Running `decx` with no arguments prints the same top-level help as `decx --help`.

## Session Management

Reuse an active session when it matches the target. Keep one session per target.

```bash
decx process list
decx process open "<file-or-url>" --name "<target-name>" --port <port>
decx process status "<target-name>"
decx process status --port <port>
decx process close --all
```

## Argument Rules

- Session-backed `decx code` and `decx android` accept `--port <port>` or `-s <name>`. When exactly one session is alive, omit both for auto-select; with multiple sessions and no `--port`/`-s`, the call silently falls back to the configured default port (client-helper fallback) without an error, so always pass one explicitly.
- adb-backed `decx android device system-services` and `decx android device permission-info` never take DECX `--port`; use `--serial` for device selection.
- Quote all identifiers: class names, method signatures, field identifiers, resource paths, package names, interface names. Strings containing `$`, `(`, `)`, `:`, or `*` are parsed by the shell and either error or target the wrong symbol; always wrap in double quotes and never rely on escaping.
- Method signatures: use the exact signature returned by `decx code search-method` or context/search results. A shortened signature such as `"Class.method"` or `"Class.method():void"` returns the wrong method, an empty body, or a stale cached match. First run `decx code search-method "<name>"`, then copy the exact returned signature into `method-source`, `method-context`, `method-cfg`, or `xref-method`. Never use shortened signatures, partial class names, placeholders, or `...`.

## Navigation

Open targets first, then inspect. Use search when the class, method, component, or resource name is unknown.

```bash
# Android metadata
decx android manifest --port <port>
decx android exported-components --port <port>
decx android deep-links --port <port>
decx android aidl-interfaces --port <port>

# Code inspection
decx code class-context "<class>" --port <port>
decx code class-source "<class>" --port <port>
decx code method-context "<signature>" --port <port>
decx code method-source "<signature>" --port <port>
decx code search-global "<keyword>" --limit <n> --port <port>
```

## Persistence

Keep notes and outputs for work that may continue later in the working directory. Close the session only when the target is no longer needed.

## Troubleshooting

| Symptom | Action |
|---|---|
| command missing, rejected, or uncertain | run nearest `--help` before retrying |
| target/name conflict on `process open` | use a new `--name` or `--force` |
| `--force` / `process close` errors with "could not stop session (pid …)" | the old JVM survived the kill; kill that pid manually, then retry the same command — the session record is kept on purpose |
| unsupported framework OEM | supported values are `vivo`, `oppo`, `xiaomi`, `honor`, `google`, `samsung` |
| `decx android framework` on Windows fails with "Windows requires WSL" | run inside WSL (install WSL and `debugfs`, e.g. `sudo apt install e2fsprogs`), or run on Linux/macOS |
| need exact command syntax | read `references/command-reference.md` |

## Gotchas

Concrete failure modes from real sessions. These are not generic CLI tips; they are conditions where the wrong call silently corrupts analysis or returns plausible-but-wrong output.

- **`--port` on adb-backed commands**: `decx android device system-services` and `decx android device permission-info` talk to adb, not the DECX HTTP server. `--port` written before the `device` subcommand is silently ignored (no error, no effect); written after it, the command fails with an unknown option error. Either way, never pass `--port`.
- **`decx code search-global` without `--limit`**: without `--limit` the server returns all matches, potentially hundreds, which burns context and frequently hides the actual hit. Always set `--limit` to a small working set (start at 20-50) and refine.
- **`process open` reuse is file-first**: when an alive session has the same file hash, DECX must reuse it even if a different `--name` was requested. A name collision matters only when no alive session matches the file; then use a fresh `--name`, pass `--force`, or close the conflicting session.
- **`process open --script` is part of the reuse key**: scripts run at decompile time, so the same file with a different `--script` set than the alive session errors until `--force`. Reopening with the same scripts reuses the session.
- **`process open` heartbeat on stderr is normal**: while waiting for server health, progress lines (elapsed + last log line) appear on stderr roughly every 15s; stdout stays JSON-only. `--timeout <seconds>` (default 300) bounds the wait; on timeout with the JVM alive the session is kept — follow up with `process status` / `process close`.
- **hierarchy results may include two spellings of one hit**: `implementations` / `subclasses` attribute nested (inner / inlined lambda `$$ExternalSyntheticLambda*`) declarations to the outer class, and the synthetic class also appears as its own entry. Treat both as hits; do not deduplicate into a false negative.
- **`decx android deep-links` / `dynamic-receivers` on a non-app target**: `decx android deep-links` returns a MANIFEST_NOT_FOUND error on targets without a manifest; `dynamic-receivers` is a code search and may return plausible-looking matches with no app semantics on a framework jar. For framework targets, use `decx android aidl-interfaces` and `decx android framework-service-implementation`.

## References

- `references/command-reference.md`
