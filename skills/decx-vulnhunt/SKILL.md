---
name: decx-vulnhunt
description: Android vulnerability hunting with DECX. Use when analyzing APK app-layer attack surfaces (exported components, deep links, WebView/Provider/Service/Receiver IPC) or Android framework/Binder targets (system_server, AIDL, system services, vendor/OEM code, privileged IPC), or composed exploit chains in either.
---

# DECX Vulnerability Hunting

Goal: prove exploitable attack paths from entrypoint to visible impact, on APK app-layer or Android framework/Binder targets.

## Routing Gate

Use for Android vulnerability hunting on APK apps or framework/Binder targets. Do not use for report writing, PoC construction, or generic DECX command help.

Route reports to `decx-report`, PoC work to `decx-poc`, raw CLI usage to `decx-cli`.

## Target Tracks

| Target | Open command | Surface | Track |
|---|---|---|---|
| APK / DEX | `decx process open` | exported components, deep links, AIDL, dynamic receivers, WebView, providers, services | App |
| processed framework JAR | `decx android framework open` | Binder services, AIDL methods, system service implementations | Framework |

Pick one track per target. Load `references/app-chains.md` (App) or `references/framework-chains.md` (Framework) for composite chains and single-pattern routing.

References are a vulnerability knowledge base, not a workflow manual — this file controls execution. Every pattern card carries YAML frontmatter `track: app|framework`; only load cards matching the active track. A card should add one of: a routing signal, a non-obvious API/Binder/identity/permission quirk or version default, or a closed-form constraint that prevents false positives. Stop reading a card when it only repeats generic Android security knowledge.

## Analysis Workflow

1. Open the target with the track's open command.
2. Collect the track's attack surface.
3. Match observed code to the track's chain pivots in `references/<track>-chains.md` and pick the smallest chain that matches. Load one or two matching `references/patterns/<track>_*.md` cards for source/sink/guard/reject rules; do not load sibling cards by name alone — only when the trace crosses that boundary.
4. Trace entry → control → guard → sink → impact with DECX commands. Record concrete evidence per step (class/method/line, trigger syntax, reachable sink).
5. Apply `references/risk-rating.md` before calling any candidate a finding.
6. Write one finding writeup per proven path (see Finding Writeup).

Use human hints when provided, but never promote a path without complete evidence.

## App Evidence Gate

Call it a finding only when concrete evidence proves every required kind along one traced path:

| Kind | Required proof |
|---|---|
| `entrypoint` | component type, exported/trigger condition, trigger syntax |
| `reachability` | attacker action reaches the path |
| `control` | attacker-controlled value reaches sink argument |
| `guard` | guard passes, is bypassed, or is absent |
| `sink` | dangerous operation |
| `impact` | visible consequence |

## Framework Evidence Gate

| Kind | Required proof |
|---|---|
| `service-entrypoint` | Binder/service method exposed |
| `binder-reachability` | unprivileged caller can reach it |
| `control` | attacker-controlled Binder parameter/state reaches sink |
| `identity` | caller identity at trust boundary |
| `permission-guard` / `appop-guard` / `user-guard` | authorization result |
| `sink` | privileged operation |
| `impact` | system-visible consequence |

Framework guards must be checked at the Binder trust boundary (caller identity bound before the privileged operation, target user bound via `INTERACT_ACROSS_USERS` before any `asUser` call).

For both tracks, reject candidates based only on names/registration, inline-only evidence, mixed evidence kinds, or scope drift.

## Finding Writeup

One proven path = one finding writeup. Field contract (one field per line):

- `id` — `F<n>`, numbered in analysis order; reused directly as report anchor and PoC spec id
- `title`
- `target` — target file + session name/port
- `entrypoint` — component/service + exported/trigger condition
- `trigger` — concrete trigger syntax
- `path` — entry → control → guard → sink, with concrete evidence per step (class/method/line level)
- `impact` — visible consequence
- `rating` — per `references/risk-rating.md` + rationale
- `evidence` — DECX command outputs / code location references

`decx-report` and `decx-poc` consume this contract; field names in this section are the single source of truth.

Hand finalized finding writeups to `decx-report` for reporting and `decx-poc` for PoC construction.

## References

- `references/app-chains.md` — App composite chains and single-pattern routing
- `references/framework-chains.md` — Framework composite chains and single-pattern routing
- `references/patterns/app_*.md` — App pattern cards (load only matching)
- `references/patterns/framework_*.md` — Framework pattern cards (load only matching)
- `references/risk-rating.md` — single rating authority for both tracks; load only before calling a candidate a finding
