---
name: decx-cli
description: Use when running DECX CLI commands to open APK, DEX, JAR, or framework targets; inspect classes, methods, source, xrefs, inheritance, or search results; inspect manifests, components, resources, AIDL, Binder metadata, or permissions for Android targets; or manage DECX sessions.
metadata:
  requires:
    bins: ["decx"]
---

# DECX CLI

Runs `decx` CLI commands for Android/Java target analysis. Targets include APK, DEX, JAR, and processed framework files.

## Routing Gate

Use only for DECX CLI command execution: session lifecycle, code/manifest inspection, or adb-backed device queries. Do not use for vulnerability analysis, chain tracing, report writing, PoC construction, or generic Android security advice. Route those to `decx-app-vulnhunt`, `decx-framework-vulnhunt`, `decx-report`, `decx-poc`, or external security guidance respectively.

## Command Selection

| Need | Command |
|---|---|
| open / reuse / close a target | `decx process` |
| classes, methods, source, xrefs, inheritance, search | `decx code` |
| manifest, components, deep links, resources, AIDL, framework services (Android only) | `decx ard` with `-P <port>` |
| live Binder services or permissions from a device (Android only) | `decx ard system-services` / `decx ard perm-info` — no `-P` |
| install or update DECX runtime | `decx self` |

Running `decx` with no arguments prints the same top-level help as `decx --help`.

## Session Management

Reuse an active session when it matches the target. Keep one session per target.

```bash
decx process list
decx process open "<file-or-url>" --name "<target-name>" -P <port>
decx process status "<target-name>" -P <port>
decx process close --all
```

## Argument Rules

- Session-backed `decx code` and `decx ard` accept `-P <port>` or `-s <name>`. When exactly one session is alive, omit both for auto-select; with multiple sessions, pass one explicitly.
- adb-backed `decx ard system-services` and `decx ard perm-info` never take `-P`; use `--serial` for device selection.
- Quote all identifiers: class names, method signatures, field identifiers, resource paths, package names, interface names.
- Method signatures: full form only — `"package.Class.method(paramType1,paramType2):returnType"`. Never use shortened signatures, partial class names, placeholders, or `...`.

If command syntax or flags are uncertain, run the nearest `--help` before retrying.

## Navigation

Open targets first, then inspect. Use search when the class, method, component, or resource name is unknown.

```bash
# Android metadata
decx ard app-manifest -P <port>
decx ard exported-components -P <port>
decx ard app-deeplinks -P <port>
decx ard get-aidl -P <port>

# Code inspection
decx code class-context "<class>" -P <port>
decx code class-source "<class>" -P <port>
decx code method-context "<signature>" -P <port>
decx code method-source "<signature>" -P <port>
decx code search-global "<keyword>" --limit <n> -P <port>
```

## Persistence

Keep notes under `.decx-analysis/<target-name>/` for work that may continue later. Close the session only when the target is no longer needed.

## Troubleshooting

| Symptom | Action |
|---|---|
| command missing, rejected, or uncertain | run nearest `--help` before retrying |
| target/name conflict on `process open` | use a new `--name` or `--force` |
| unsupported framework OEM | supported values are `vivo`, `oppo`, `xiaomi`, `honor`, `google`, `samsung` |
| need exact command syntax | read `references/command-reference.md` |

## Gotchas

Concrete failure modes from real sessions. These are not generic CLI tips; they are conditions where the wrong call silently corrupts analysis or returns plausible-but-wrong output.

- **Multiple sessions + omitted `-P`/`-s`**: `decx code` and `decx ard` auto-select only when one session is alive. Once more than one session exists, always pass `-P <port>` or `-s <name>`.
- **Shortened method signature**: `"Class.method"` or `"Class.method():void"` returns wrong method, an empty body, or a stale cached match. Use the full form `"package.Class.method(paramType1,paramType2):returnType"`. Never substitute `...` or drop parameter types.
- **`-P` on adb-backed commands**: `decx ard system-services` and `decx ard perm-info` talk to adb, not the DECX HTTP server. Adding `-P <port>` causes the command to fail with an unrelated error and may mask the real adb connectivity issue.
- **`decx code search-global` without `--limit`**: returns up to the server default (often hundreds of matches), burns context, and frequently hides the actual hit. Always set `--limit` to a small working set (start at 20–50) and refine.
- **`process open` reuses file but fails on name conflict**: a previous session with the same `--name` is still bound. Either pick a fresh `--name`, pass `--force` to rebind, or close the old session first with `decx process close`.
- **Forgetting to quote identifiers with shell metacharacters**: class/method/URI strings containing `$`, `(`, `)`, `:`, or `*` are parsed by the shell and either error or target the wrong symbol. Always wrap in double quotes; never rely on escaping.
- **`decx ard app-deeplinks` / `app-receivers` return empty on a non-app target**: these commands require an APK session, not a framework bundle. Use `decx ard get-aidl` and `decx ard system-service-impl` for framework targets.

## References

- `references/command-reference.md`
