---
name: decx-framework-vulnhunt
description: Android framework vulnerability hunting with DECX. Use when analyzing processed framework bundles, system_server, Binder services, AIDL implementations, vendor/OEM framework code, or privileged framework IPC exploit chains.
metadata:
  requires:
    bins: ["decx"]
---

# DECX Framework Vulnerability Hunting

Use this skill only for DECX-backed static framework and Binder-service hunts where the blackboard workflow matters: final processed framework target binding, Binder/service attack-surface routing, caller identity evidence, delegated trace work, evidence gates, or multi-primitive framework exploit composition.

Route elsewhere:

- `decx-app-vulnhunt`: APK exported components, app Providers/Receivers/Services, deep links, WebView hosts, and app-layer IPC.
- `decx-cli`: command help only.
- `decx-report`: finalized report writing.
- `decx-poc`: PoC or verification artifact implementation.

Do not use this skill for APK app-layer flows, generic Android security advice, raw source review without DECX state, standalone reports, or PoC coding.

## Instructions

1. **Prepare one framework target**: open or confirm one final processed framework DECX session, choose a target directory, then initialize `.decx-analysis/<target>/decx-analysis.db`.
2. **Create bounded intents**: each intent must ask one concrete question, such as collecting a bounded service surface, classifying one Binder method family, tracing one service method to one privileged sink, validating one composition edge, or reviewing one evidence chain.
3. **Delegate target queries**: the main agent orchestrates only. Service enumeration, AIDL/Stub lookup, permission queries, source reads, xrefs, method context, resources, and searches belong inside dispatched subagent intents. Session health checks and blackboard maintenance are allowed in the main context.
4. **Dispatch before claim**: every intent must be dispatched to exactly one subagent, then claimed by that subagent.
5. **Keep one intent per subagent invocation**: a subagent may write facts, events, links, chains, hints, and follow-up intents, but must not execute a second intent in the same invocation.
6. **Absorb evidence atomically**: prefer `result` to write subagent facts/events and close the intent. Use `link` or `chain` when multiple facts jointly prove caller identity, guard outcome, sink, and impact.
7. **Promote only after review**: record candidate, promoted, or rejected events only after facts and links satisfy the framework promotion gate.
8. **Close composition before final output**: before ending analysis, review all promoted primitives and candidate Binder/service chains for `enable`, `carry`, `amplify`, `bypass`, or `observe` edges. Dispatch one bounded composition-validation intent for each plausible pair or chain.
9. **Hand off deliverables**: after all intents are resolved and composition is closed, route reports to `decx-report` and PoC/verification artifact construction to `decx-poc`, unless the user explicitly requested analysis-only output.

## Blackboard

One SQLite database per target:

```bash
node scripts/decx-analysis-db.mjs init <dir> --session <name> --kind android_framework
```

Core records:

- **Facts** are immutable observations. Prefix fact descriptions with the observation type: `entrypoint:`, `surface:`, `reachability:`, `control:`, `guard:`, `sink:`, `impact:`, `composition:`, or `dead-end:`.
- **Intents** are concrete subagent questions, not workflow phases. Statuses are `open`, `working`, `done`, and `failed`.
- **Events** record dispatch, claim, review, promotion, rejection, and notable workflow decisions.
- **Links/chains** connect facts that jointly prove a path. Prefer them over a single concluded fact for multi-hop evidence.

Key commands:

```bash
node scripts/decx-analysis-db.mjs fact <dir> --description <text> [--evidence <json>] [--source <src>]
node scripts/decx-analysis-db.mjs facts <dir> [--session <name>]
node scripts/decx-analysis-db.mjs intent <dir> --description <text> --from <factId,...> --agent <role> [--priority <n>]
node scripts/decx-analysis-db.mjs dispatch <dir> <intentId> --to <subagent>
node scripts/decx-analysis-db.mjs claim <dir> <intentId> [--by <worker>]
node scripts/decx-analysis-db.mjs result <dir> <intentId> --facts <json> [--events <json>] [--conclude <factId|last>] [--fail <reason>] [--by <worker>]
node scripts/decx-analysis-db.mjs conclude <dir> <intentId> --fact <factId>
node scripts/decx-analysis-db.mjs fail <dir> <intentId> --reason <text>
node scripts/decx-analysis-db.mjs intents <dir> [--status <st>]
node scripts/decx-analysis-db.mjs hint <dir> --content <text> [--creator <who>]
node scripts/decx-analysis-db.mjs absorb <dir> <hintId>
node scripts/decx-analysis-db.mjs hints <dir>
node scripts/decx-analysis-db.mjs event <dir> --type <type> [--data <json>]
node scripts/decx-analysis-db.mjs link <dir> --from <factId> --to <factId> [--kind <k>]
node scripts/decx-analysis-db.mjs chain <dir> --facts <factId,...> [--kind <k>]
node scripts/decx-analysis-db.mjs graph <dir>
node scripts/decx-analysis-db.mjs path <dir> --from <factId> --to <factId>
node scripts/decx-analysis-db.mjs export <dir>
node scripts/decx-analysis-db.mjs stats <dir>
```

## Hunting Method

Use `references/index.md` as the authority for framework coverage and pattern routing.

- Start with `Composite Framework Chains`; combined exploitability is the primary output goal.
- After surface enumeration, prioritize primitive pairs connected by `enable`, `carry`, `amplify`, or `bypass`.
- Use `Single Pattern Routing` only when the observed service code shape does not compose with another boundary and a `dead-end:` fact records why.
- Load references only when they add a routing signal, trace cue, promotion gate, or false-positive constraint for the current candidate.
- Stop loading more references when they only repeat generic Android security knowledge.

For each candidate, map:

- Binder/service entrypoint signature and service name
- attacker precondition: unprivileged app, same UID/package claim, cross-user caller, shell/adb-only, malicious provider/URI, malicious PendingIntent, or user interaction
- attacker-controlled parameters: package, UID, userId, token, URI, Intent, Bundle, Parcel, PendingIntent, file path, or callback
- caller identity or authorization evidence
- guard before privileged trust boundary
- suspected privileged sink and impact hypothesis
- defensive control expected to block the path
- next DECX query or intent to create

Subagents must prove exact branch outcomes and identity or authorization state at every relevant hop. Method names, service names, and registration alone are not evidence.

## Composition

Allowed edge types:

- `enable`: one primitive creates access needed by the next.
- `carry`: one primitive transports UID, package, user, URI, Intent, token, PendingIntent, or Binder state.
- `amplify`: one primitive increases final framework/system impact.
- `bypass`: one primitive defeats permission, app-op, identity, user, or callee defense.
- `observe`: callback, broadcast, result receiver, provider query, or launched Intent makes impact visible.

For each composed chain, record ordered stage ids, caller identity per stage, transferred object/identity/control flow, trust boundary, bypassed defense, final impact, and why the chain is realistic.

Reject composition when stages are merely adjacent, require incompatible caller identities, depend on unproven race timing, lose Binder identity between stages, require privileged setup outside the code path, have no transferred object/identity/control flow, hit non-bypassable authorization, or lack combined impact.

Record:

- `composition:` only after a dedicated subagent re-opens each stage, proves all edges, proves transferred object/identity/control flow, and confirms exact identity, authorization, and branch outcomes under composed preconditions.
- `dead-end:` only for checked plausible compositions, naming tested stage ids, rejected edge type, and the concrete blocker.

## Promotion Gate

Promote only when all are proven as facts:

- Binder/service reachability
- attacker-controlled parameter or object
- exact permission/app-op/UID/package/user/identity branch outcome
- sink argument
- visible framework/system impact
- rating rationale from `references/risk-rating.md`
- evidence suitable for `decx-report`

For composed framework candidates, rate the final attacker-reachable framework/system impact after Binder reachability, caller identity, authorization state, transferred object/control flow, and sink effect compose. If the combined path is unproven, rate/report only the independently proven primitive impact or keep the record as candidate/residual.

Single-primitive findings are final only when composition is proven impossible or no plausible composition candidate exists.

## Command Reference

Use `decx-cli` as the authority for DECX command names, flags, identifier formats, and port/session behavior. If command syntax is uncertain, route command help to `decx-cli` or run the nearest `--help`; do not guess DECX syntax in this skill.

Framework-hunt-specific command rules:

- Analyze one final framework code target per hunt; if only split `source/` jars exist, use the framework collect/process/run path described by `decx-cli` instead of opening an intermediate jar.
- Main agent may open/check the framework session and maintain the blackboard; target inspection commands belong inside dispatched subagent intents.
- Session-backed `decx code` and `decx ard` queries must identify the intended session with `-P <port>` or `-s <name>` when more than one session exists.
- adb-backed `system-services`, `perm-info`, and `framework collect/process` follow `decx-cli` port rules and must not be treated as DECX HTTP session queries.

## Examples

Example intent shapes:

- Collect bounded Binder/service surface for one processed framework target.
- Classify one service or Binder method family against `references/index.md` and create follow-up trace intents.
- Trace one service entrypoint to one privileged sink, proving reachability, caller control, identity/authorization state, sink argument, and impact.
- Validate one plausible `bypass` edge from an identity transition to a protected service action.
- Review one candidate chain against the promotion gate and `references/risk-rating.md`.

Example fact prefixes:

- `service-entrypoint: service "..." exposes Binder method "..."`
- `binder-reachability: unprivileged app can reach "..."`
- `identity: caller UID/package is derived from Binder.getCallingUid() before clearCallingIdentity`
- `permission-guard: permission check allows path when ...`
- `sink: controlled userId reaches privileged cross-user operation "..."`
- `impact: attacker can trigger system-visible state change via "..."`
- `dead-end: stages 7,14 cannot compose because Binder identity is lost before the second guard`

## Constraints

- Analyze one final framework code target per hunt; stop and ask if given only split `source/` jars and no collect/process path.
- Every intent must be dispatched to exactly one subagent before it is claimed.
- Main agent must not substitute direct target queries for recon or trace intents.
- Do not trace multiple chains in one worker invocation.
- Do not scan every reference for one target.
- Method signatures must use full form: `"package.Class.method(paramType):returnType"`; never use `...`.
- Quote package names, classes, methods, interfaces, Binder names, and file paths.
- Do not report reachable Binder behavior without downstream impact.
- A nearby primitive is not a finding until reachability, attacker control, sink impact, and guard bypass are each proven.
- Do not close analysis until composition validation has been attempted for every plausible promoted primitive pair, or the main agent can demonstrate there is only one promoted primitive.
- Do not claim `poc-validated`, `runtime-validated`, `verified exploitable`, or equivalent.
- Hand off at 60% context usage with the target directory and active session name, not raw source dumps.
- Do not generate report templates, PoC code, or vulnerability descriptions inside this skill.

## Troubleshooting

| Symptom | Action |
|---|---|
| Missing or rejected command | Use `decx-cli` or run the nearest `--help`. |
| Impact does not map to `risk-rating.md` | Keep evidence unverified; do not compose or promote. |
| Source reaches unknown helper | Open the helper body and prove the exact branch. |
| Reference adds no trace cue, promotion gate, or chain pivot | Stop using it. |
| Intent appears stuck | Check `intents --status open`; claim or fail stale intents. |
| Fact count grows without concluded intents | Run `stats`, find sources with no sink/impact facts, and create targeted intents. |

## Gotchas

- **Split framework inputs**: opening one intermediate jar under `source/` loses identity, AIDL/Stub paths, and cross-service edges. Use the framework collect/process/run path from `decx-cli`.
- **Method-name inference**: helper names such as `check*` or `validate*` are not evidence. Open the body, prove the branch, and write a `permission-guard:`, `appop-guard:`, `user-guard:`, or `identity:` fact.
- **Main-agent recon or tracing**: service enumeration, AIDL/Stub lookup, permission queries, source, xref, method context, and search commands are subagent work.
- **Registration-only reachability**: a registered service or promising method name is not proof. Dispatch a bounded subagent intent to prove externally reachable entrypoint and caller-controlled parameters.
- **Vague fact descriptions**: fact descriptions must identify the observation type and concrete evidence. Do not label caller control as Binder reachability or write sink facts without impact evidence.
- **Orphan intents**: intents without `--from <factId,...>` cannot be prioritized from the blackboard.
- **Incomplete path proof**: every hop needs facts for reachability, control, identity/authorization, guard, sink, and impact as applicable.
- **Multiple claimed intents**: one subagent invocation handles one intent.
- **Composition without transfer evidence**: adjacent facts are not a chain. Use `chain` or `link` only after a subagent proves how identity, object, token, user, control flow, or observable result moves between facts.
- **Missing authorization evidence**: a framework finding needs facts proving caller identity or authorization state at the relevant trust boundary.
- **Reachability-only reporting**: reachable Binder methods without proven sink arguments, caller-controlled parameters, and visible system effects are reconnaissance, not findings.
- **Timing claims without evidence**: async or race-shaped hypotheses need proof that the attacker can influence the timing or state transition.
- **Optional composition**: isolated promoted primitives are incomplete until plausible composition has been validated or rejected with `dead-end:` facts.

## References

- `references/index.md`
- `references/risk-rating.md`
- `references/overviews/*.md`
- `references/patterns/*.md`
- `references/casebooks/*.md`
