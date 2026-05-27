---
name: decx-cli
description: DECX CLI usage. Use when the user asks how to run decx commands; open APK, DEX, JAR, or processed framework targets; inspect classes, methods, source, xrefs, inheritance, search results; or for Android targets, also inspect manifests, resources, components, AIDL, Binder/system-service metadata, and permissions; or manage DECX sessions.
metadata:
  requires:
    bins: ["decx"]
---

# DECX CLI

Use this skill to run and explain `decx` CLI commands. DECX opens APK, DEX, JAR, and processed framework targets.

## Instructions

Step 1: Choose The Command Family

| User need | Use first |
|---|---|
| open/reuse/check/close a target | `decx process` |
| inspect classes, methods, source, xrefs, inheritance, or search results | `decx code` |
| inspect manifest, components, deep links, resources, AIDL, framework service impls (Android only) | `decx ard` with `-P <port>` |
| inspect live Binder services or permissions from a device (Android only) | `decx ard system-services` / `decx ard perm-info` without `-P` |
| install or update DECX runtime pieces | `decx self` |

If command syntax, command name, flags, or port requirements are uncertain, stop and run the nearest `--help` command before retrying. This is mandatory.

Step 2: Open Or Reuse
- Reuse an active DECX session when it matches the target.
- Otherwise open one target session with a stable name.
- Keep one DECX session per target unless the user explicitly changes target.

```bash
decx process list
decx process open "<file-or-url>" --name "<target-name>" -P <port>
decx process status "<target-name>" -P <port>
```

Step 3: Format Arguments Exactly
- Put `-P <port>` on every session-backed `decx code` and `decx ard` command.
- Do not put `-P` on adb-backed `decx ard system-services` or `decx ard perm-info`.
- Quote class names, method signatures, field identifiers, resource paths, file paths, package names, and interface names.
- Use full method signatures only: `"package.Class.method(paramType1,paramType2):returnType"`.
- Never use shortened signatures, partial class names, placeholders, or `...`.

Step 4: Navigate
- Open APK, DEX, JAR, or processed framework targets as needed.
- Use `decx code` for classes, methods, source, xrefs, inheritance, interfaces, and search.
- Use `decx ard` for Android-specific metadata: manifest, components, deep links, resources, AIDL, and live device info.
- If unsure which command or flag applies, run the nearest `--help` first.
- Use search only when the class, method, component, or resource is unknown.

```bash
decx ard app-manifest -P <port>
decx ard exported-components -P <port>
decx ard app-deeplinks -P <port>
decx ard get-aidl -P <port>
decx code class-context "<class>" -P <port>
decx code method-context "<signature>" -P <port>
decx code method-source "<signature>" -P <port>
```

Step 5: Persist Or Close
- Keep notes under `.decx-analysis/<target-name>/` when work may continue later.
- Close the session only when the user is done with the target.

## Examples

Example 1: JAR analysis
- Open the JAR with `decx process open "<jar>" --name "<name>" -P <port>`.
- Use `decx code` commands to inspect classes, methods, xrefs, inheritance, and search.

Example 2: APK analysis
- Open the APK, then use both `decx code` and `decx ard` commands.
- `decx ard` for manifest, components, deep links, resources, AIDL.
- `decx code` for implementation details, source, xrefs, inheritance.

Example 3: Live device metadata
- Use adb-backed `decx ard system-services` / `decx ard perm-info` for live Binder service or permission queries from a connected device.

## Constraints

- DECX opens APK, DEX, JAR, and processed framework targets.
- Session-backed `decx code` and `decx ard` commands must include `-P <port>`.
- adb-backed `decx ard system-services` and `decx ard perm-info` do not use `-P <port>`; use `--serial` or `--adb-path` when needed.
- If any command is missing, rejected, or uncertain, run the nearest `--help` command before trying another form.
- Method signatures must use full form: `"package.Class.method(paramType1,paramType2):returnType"`.
- Never use `...` in signatures.
- Quote package names, class names, method signatures, field identifiers, interface names, file paths, and resource paths.
- Do not invent argument names or order; verify with `--help` when the format is not certain.
- Do not paste long raw source dumps unless explicitly requested.
- Do not turn navigation output into security conclusions unless the user explicitly asks for analysis beyond CLI usage.

## Troubleshooting

- Command is missing, rejected, or uncertain -> run the nearest `--help` command before retrying; do not guess syntax.
- Session command fails because target/name conflicts -> use a new `--name` or `--force` only when replacing the session is intentional.
- Need exact command syntax -> read `references/command-reference.md`.

## References

- `references/command-reference.md`
