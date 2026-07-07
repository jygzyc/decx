---
name: poc-workflow
description: PoC DAG intake, spec, and optional build/deploy flow.
---

# PoC Workflow Reference

## Read Finding

```bash
node skills/decx-analysis-core/scripts/decx-graph.mjs facts <graph-dir> --kind app-finding
node skills/decx-analysis-core/scripts/decx-graph.mjs facts <graph-dir> --kind framework-finding
node skills/decx-analysis-core/scripts/decx-graph.mjs path <graph-dir> --from <entry_fact> --to <impact_fact>
node skills/decx-analysis-core/scripts/decx-graph.mjs ancestors <graph-dir> --from <impact_fact>
```

## Re-check

Stop if entry→impact path is missing, evidence artifacts are unreadable, or PoC Spec fields cannot be filled from accepted facts.

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
