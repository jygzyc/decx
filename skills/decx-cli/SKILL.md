---
name: decx-cli
description: Runs DECX CLI commands to open APK, DEX, JAR, or framework targets; inspect classes, methods, source, xrefs, inheritance, search results; inspect manifests, components, resources, AIDL, Binder metadata, and permissions for Android targets; and manage DECX sessions.
metadata:
  requires:
    bins: ["decx"]
---

# DECX CLI

Runs `decx` CLI commands for Android/Java target analysis. Targets include APK, DEX, JAR, and processed framework files.

## Command Selection

| Need | Command |
|---|---|
| open / reuse / close a target | `decx process` |
| classes, methods, source, xrefs, inheritance, search | `decx code` |
| manifest, components, deep links, resources, AIDL, framework services (Android only) | `decx ard` with `-P <port>` |
| live Binder services or permissions from a device (Android only) | `decx ard system-services` / `decx ard perm-info` — no `-P` |
| install or update DECX runtime | `decx self` |

## Session Management

Reuse an active session when it matches the target. Keep one session per target.

```bash
decx process list
decx process open "<file-or-url>" --name "<target-name>" -P <port>
decx process status "<target-name>" -P <port>
decx process close --all
```

## Argument Rules

- Session-backed `decx code` and `decx ard` require `-P <port>` or `-s <name>`. When only one session is alive, omit both for auto-select.
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
| need exact command syntax | read `references/command-reference.md` |

## References

- `references/command-reference.md`
