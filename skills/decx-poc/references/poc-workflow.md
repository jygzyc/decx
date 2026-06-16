---
name: poc-workflow
description: PoC proof graph contract, re-verification, compile/deploy, and final output format.
---

# PoC Workflow Reference

## Read Verified Chain

```bash
node scripts/decx-analysis-db.mjs chains <dir> --root-prefix entrypoint --leaf-prefix impact
node scripts/decx-analysis-db.mjs path <dir> --from <entrypoint_fact> --to <sink_fact>
node scripts/decx-analysis-db.mjs ancestors <dir> --fact <sink_fact>
```

Required: entrypoint + sink fact IDs, full fact→edge→fact path, guard + impact facts along path, trigger/steps/successSignal/requirements (from fact bodies or evidence files).

Determine target kind from fact prefixes: `service-entrypoint` or `binder-reachability` → framework; otherwise app.

| Aspect | App prefix | Framework prefix |
|---|---|---|
| Entry | `entrypoint` | `service-entrypoint` |
| Reachability | `reachability` | `binder-reachability` |
| Identity | (not used) | `identity` |
| Control | `control` | `control` |
| Guard | `guard` | `permission-guard` / `appop-guard` / `user-guard` / `identity-transition` |
| Sink | `sink` | `sink` |
| Impact | `impact` | `impact` |

## Re-Verification

Before coding, verify via graph queries:

1. `chains` or `path` returns a connected chain from entrypoint to impact
2. Entry fact prefix + body match the same entrypoint shape
3. Source is attacker-controlled
4. Sink is reachable
5. No missed non-bypassable guard
6. `trigger`, `steps`, `successSignal`, `requirements` are sufficient

If any check fails, stop before project creation.

## Construction Selection

- Choose the shortest path that proves the verified impact
- Model two-stage exploits as `capture → trigger`
- Do not invent handle acquisition, remote servers, or helpers the finding did not prove
- Prefer local `server/` payload over remote infrastructure

## Project Creation

```bash
node skills/decx-poc/scripts/setup-poc.mjs <target-app>
```

Copies `assets/poc-template-app/` → `poc-<target>/app/` and `assets/poc-template-server/` → `poc-<target>/server/`. Reuse the same project for later findings against the same target.

## Optional Compile

Only when explicitly requested:

```bash
node skills/decx-poc/scripts/check-env.mjs
cd poc-<target>/app && timeout 300 ./gradlew assembleDebug --no-daemon
```

## Optional Deploy

Only when explicitly requested and a device/emulator is available:

```bash
adb install app/build/outputs/apk/debug/app-debug.apk
adb logcat -s PoC:I AndroidRuntime:E
adb uninstall com.poc.<target>
```

Runtime proof must name the exact observed effect: non-exported activity opened, protected provider rows returned, privileged Binder method accepted, etc.

## Final Output

Close with: `state`, `projectPath`, `activeFinding`, `trigger`, `successSignal`, `requirements`, `exploitClass`, `filesChanged`, `manifestChanges`, `buildStatus`, `runtimeStatus`, `remainingManualSteps`.

State that explicitly if stopped before compile or runtime validation.
