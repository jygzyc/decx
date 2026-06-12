---
name: poc-workflow
description: PoC blackboard contract, re-verification, compile/deploy, and final output format.
---

# PoC Workflow Reference

## PoC-Ready Graph Path

Use one verified chain from the SQLite blackboard. Query with:

```bash
node scripts/decx-analysis-db.mjs export <dir>
node scripts/decx-analysis-db.mjs path <dir> --from <entrypoint_fact> --to <sink_fact>
```

Required data from the blackboard:

- entrypoint fact, sink fact, and the full fact→intent→fact path between them
- controllability, guard, and impact facts along the path (prefixes differ by target kind; see below)
- PoC trigger description, steps, expected result, success signal, and requirements (stored as fact descriptions or event data)

Determine target kind from fact descriptions: if any fact starts with `service-entrypoint:` or `binder-reachability:`, the target is framework; otherwise app.

Fact prefixes by target kind:

| Aspect | App prefix | Framework prefix |
|---|---|---|
| Entry | `entrypoint:` | `service-entrypoint:` |
| Reachability | `reachability:` | `binder-reachability:` |
| Identity | (not used) | `identity:` |
| Control | `control:` | `control:` |
| Guard | `guard:` | `permission-guard:` / `appop-guard:` / `user-guard:` / `identity-transition:` |
| Sink | `sink:` | `sink:` |
| Impact | `impact:` | `impact:` |

Do not create or consume XML artifacts. Use `export` and `path` queries as source of truth.

## Re-Verification

Mandatory re-verification before coding. The main workflow queries the blackboard graph and verifies sink/trigger conditions inline.

Minimum checks:

1. surface exists
2. entry point matches
3. source is attacker-controlled
4. sink is reachable
5. no missed non-bypassable guard
6. `poc.trigger`, `poc.steps`, `successSignal`, `requirements` are sufficient

Write as:

```text
- [PASS/FAIL] Surface exists: ...
- [PASS/FAIL] Entry point matches: ...
- [PASS/FAIL] Source is attacker-controlled: ...
- [PASS/FAIL] Sink is reachable: ...
- [PASS/FAIL] No missed non-bypassable guard: ...
- [PASS/FAIL] PoC trigger block is sufficient: ...
```

If any check fails, stop before project creation or code generation.

## Construction Selection

- `trigger`: concrete delivery path (exported component, Intent, Binder, WebView, URI, UI-assisted sequence)
- `steps`: shortest attacker action sequence reaching the verified sink
- `requirements`: only what the PoC really needs (helper component, manifest entry, server asset, device state)

Rules:

- Choose the shortest path that proves the verified impact.
- Model two-stage exploits as `capture -> trigger`.
- Do not invent handle acquisition, remote servers, or helpers the finding did not prove.
- Prefer local `server/` payload over remote infrastructure.

## Project Creation

```bash
node skills/decx-poc/scripts/setup-poc.mjs <target-app>
```

Copies `assets/poc-template-app/` to `poc-<target>/app/` and `assets/poc-template-server/` to `poc-<target>/server/`, replaces placeholders, renames package path segments. Reuse the same project for later findings against the same target.

## Optional Compile

Only when explicitly requested.

```bash
node skills/decx-poc/scripts/check-env.mjs
cd poc-<target-app>/app && timeout 300 ./gradlew assembleDebug --no-daemon
```

## Optional Deploy And Runtime Check

Only when explicitly requested and a device/emulator is available.

```bash
adb devices
adb install app/build/outputs/apk/debug/app-debug.apk
adb logcat -s PoC:I AndroidRuntime:E
adb uninstall com.poc.<target-app>
```

Runtime proof must name the exact observed effect: non-exported activity opened, protected provider rows returned, privileged Binder method accepted, victim WebView loaded attacker content, etc.

## Final Output Contract

Close with: `state`, `projectPath`, `activeFinding`, `sourceId`, `sinkId`, `flowSig`, `trigger`, `successSignal`, `requirements`, `exploitClass`, `filesChanged`, `manifestChanges`, `deliveryArtifacts`, `buildStatus`, `runtimeStatus`, `remainingManualSteps`.

State that explicitly if stopped before compile or runtime validation.
