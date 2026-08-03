---
name: poc-workflow
description: PoC finding intake, spec, and optional build/deploy flow.
---

# PoC Workflow Reference

## Read Finding

Read one finalized finding writeup. Confirm its entry→impact path and that all referenced evidence artifacts are available.

## Re-check

Stop if the entry→impact path is missing, evidence artifacts are unreadable, or PoC Spec fields cannot be filled from the finding.

## Build Flow

1. Build `poc-spec.md`.
2. Select one route from `index.md`.
3. Create project with `setup-poc.mjs`.
4. Edit template files.
5. Compile/deploy only if explicitly requested.

## Commands

```bash
node skills/decx-poc/scripts/setup-poc.mjs <target>
node skills/decx-poc/scripts/check-env.mjs
cd poc-<target>/app && timeout 300 ./gradlew assembleDebug --no-daemon
```

## Final Output

Return: `state`, `projectPath`, `findingId`, `exploitId`, `trigger`, `successSignal`, `requirements`, `filesChanged`, `buildStatus`, `runtimeStatus`, `remainingManualSteps`.
