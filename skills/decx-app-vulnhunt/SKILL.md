---
name: decx-app-vulnhunt
description: APK app-layer vulnerability hunting with DECX. Use when analyzing exported components, deep links, WebView/Provider/Service/Receiver IPC paths, app attack surfaces, or composed APK exploit chains.
---

# DECX App Vulnerability Hunting

Goal: prove exploitable APK attack paths from attacker entrypoint to visible impact.

## Routing Gate

Use for APK/app-layer vulnerability hunting. Do not use for framework/Binder framework hunts, report writing, PoC construction, or generic DECX command help.

Use `decx-analysis-core` for the Fact/Intent/Hint DAG. Route reports to `decx-report`, PoC work to `decx-poc`, framework/Binder framework hunts to `decx-framework-vulnhunt`.

## Role Boundary

- **Planner/Main Agent**: open DECX session, initialize root facts/intents, record human Hints, claim runnable Intents, dispatch Generator/Evaluator subagents, read returned node IDs/queries, run `check`/`chains`, decide promotion.
- **Generator subagent**: execute one claimed Intent using DECX commands, load only routed references, write evidence artifacts, return temp facts. It may chain once to another Generator inside the same Intent when context is insufficient.
- **Evaluator subagent**: check temp facts against this evidence gate, write accepted Facts, close/fail the Intent, return generated node IDs/queries.

Planner must not run `decx code` / `decx ard` or read source. Generator must not write DAG truth. Evaluator must not explore new directions.

## Core Commands

```bash
node skills/decx-analysis-core/scripts/decx-graph.mjs init <graph-dir> --session <name> --kind android_app
node skills/decx-analysis-core/scripts/decx-graph.mjs fact <graph-dir> --root --kind target --body "APK target opened for analysis" --evidence <target-path>
node skills/decx-analysis-core/scripts/decx-graph.mjs intent <graph-dir> --root --goal "Collect attack surface: exported components, deep links, AIDL, dynamic receivers" --phase surface
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

1. `init` + `decx process open`.
2. Add root target Fact and root surface Intent.
3. Record human Hints when provided.
4. Claim open/expired Intents and launch one Generator per claim.
5. Launch one Evaluator for returned temp facts.
6. Planner creates next Intents from accepted Facts + Hints, after checking failed/cancelled Intents for duplicate blockers.
7. Promote only after `check`/`chains` proves a complete accepted path.

## APP Evidence Gate

Promote only when accepted Facts prove all required kinds along a derived DAG path:

| Kind | Required proof |
|---|---|
| `entrypoint` | component type, exported/trigger condition, trigger syntax |
| `reachability` | attacker action reaches the path |
| `control` | attacker-controlled value reaches sink argument |
| `guard` | guard passes, is bypassed, or is absent |
| `sink` | dangerous operation |
| `impact` | visible consequence |

Reject temp facts based only on names, inline-only evidence, mixed evidence kinds, or scope drift.

## Promotion

Promotion is a dedicated Intent. Evaluator writes exactly one finding Fact:

```bash
node skills/decx-analysis-core/scripts/decx-graph.mjs fact <graph-dir> --from <promotion_intent> --kind app-finding --body "<finding title + impact>" --evidence <finding-evidence.md>
```

The evidence file must name entry fact, impact fact, required path facts, target/session, and rating decision.

## References

- `skills/decx-analysis-core/references/graph-protocol.md`
- `skills/decx-analysis-core/references/role-protocol.md`
- `references/index.md` — load by Generator/Evaluator for routing
- `references/patterns/*.md` — load only matching pattern cards
- `references/risk-rating.md` — load only before promotion
