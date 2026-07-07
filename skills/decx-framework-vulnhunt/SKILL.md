---
name: decx-framework-vulnhunt
description: Android framework vulnerability hunting with DECX. Use when analyzing processed framework bundles, system_server, Binder services, AIDL implementations, vendor/OEM framework code, or privileged framework IPC exploit chains.
---

# DECX Framework Vulnerability Hunting

Goal: prove exploitable framework paths from Binder/service entrypoint to system-visible impact.

## Routing Gate

Use for Android framework/system_server/Binder vulnerability hunting. Do not use for APK app-layer hunts, report writing, PoC construction, or generic DECX command help.

Use `decx-analysis-core` for the Fact/Intent/Hint DAG. Route reports to `decx-report`, PoC work to `decx-poc`, APK hunts to `decx-app-vulnhunt`.

## Role Boundary

- **Planner/Main Agent**: open final processed framework target, initialize root facts/intents, record human Hints, claim runnable Intents, dispatch Generator/Evaluator subagents, read returned node IDs/queries, run `check`/`chains`, decide promotion.
- **Generator subagent**: execute one claimed Intent using DECX commands, load only routed references, write evidence artifacts, return temp facts. It may chain once to another Generator inside the same Intent when context is insufficient.
- **Evaluator subagent**: check temp facts against this evidence gate, write accepted Facts, close/fail the Intent, return generated node IDs/queries.

Planner must not run `decx code` / `decx ard` or read source. Generator must not write DAG truth. Evaluator must not explore new directions.

## Core Commands

```bash
node skills/decx-analysis-core/scripts/decx-graph.mjs init <graph-dir> --session <name> --kind android_framework
node skills/decx-analysis-core/scripts/decx-graph.mjs fact <graph-dir> --root --kind target --body "Framework target opened for analysis" --evidence <target-path>
node skills/decx-analysis-core/scripts/decx-graph.mjs intent <graph-dir> --root --goal "Collect framework surface: Binder services, AIDL methods, system services" --phase surface
node skills/decx-analysis-core/scripts/decx-graph.mjs intent <graph-dir> --from <node,...> --goal "<question>" --phase <stage>
node skills/decx-analysis-core/scripts/decx-graph.mjs start <graph-dir> <intentId> --by <generator-id> [--lease-ms 1800000]
node skills/decx-analysis-core/scripts/decx-graph.mjs renew <graph-dir> <intentId> --by <generator-id>
node skills/decx-analysis-core/scripts/decx-graph.mjs fact <graph-dir> --from <intentId> --kind <type> --body "<accepted evidence>" --evidence <path>
node skills/decx-analysis-core/scripts/decx-graph.mjs hint <graph-dir> --from <node> --body "<human suggestion>" --author human
node skills/decx-analysis-core/scripts/decx-graph.mjs solve <graph-dir> <intentId> --status solved|failed|cancelled
node skills/decx-analysis-core/scripts/decx-graph.mjs check <graph-dir>
node skills/decx-analysis-core/scripts/decx-graph.mjs chains <graph-dir>
```

## Dispatch Loop

1. `init` + `decx ard framework open` final processed JAR.
2. Add root target Fact and root surface Intent.
3. Record human Hints when provided.
4. Claim open/expired Intents and launch one Generator per claim.
5. Launch one Evaluator for returned temp facts.
6. Planner creates next Intents from accepted Facts + Hints, after checking failed/cancelled Intents for duplicate blockers.
7. Promote only after `check`/`chains` proves a complete accepted path.

## Framework Evidence Gate

Promote only when accepted Facts prove all required kinds along a derived DAG path:

| Kind | Required proof |
|---|---|
| `service-entrypoint` | Binder/service method exposed |
| `binder-reachability` | unprivileged caller can reach it |
| `control` | attacker-controlled Binder parameter/state reaches sink |
| `identity` | caller identity at trust boundary |
| `permission-guard` / `appop-guard` / `user-guard` | authorization result |
| `sink` | privileged operation |
| `impact` | system-visible consequence |

Reject temp facts based only on names/registration, inline-only evidence, mixed evidence kinds, or scope drift.

## Promotion

Promotion is a dedicated Intent. Evaluator writes exactly one finding Fact:

```bash
node skills/decx-analysis-core/scripts/decx-graph.mjs fact <graph-dir> --from <promotion_intent> --kind framework-finding --body "<finding title + impact>" --evidence <finding-evidence.md>
```

The evidence file must name entry fact, impact fact, required path facts, target/session, and rating decision.

## References

- `skills/decx-analysis-core/references/graph-protocol.md`
- `skills/decx-analysis-core/references/role-protocol.md`
- `references/index.md` — load by Generator/Evaluator for routing
- `references/patterns/*.md` — load only matching pattern cards
- `references/risk-rating.md` — load only before promotion
