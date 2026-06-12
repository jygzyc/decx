---
name: decx-app-vulnhunt
description: APK app-layer vulnerability hunting with DECX. Use when analyzing exported components, deep links, WebView/Provider/Service/Receiver IPC paths, app attack surfaces, or composed APK exploit chains.
metadata:
  requires:
    bins: ["decx"]
---

# DECX App Vulnerability Hunting

Use this skill only for DECX-backed APK app-layer hunts where the blackboard workflow matters: APK session binding, attack-surface routing, Fact/Intent/Event tracking, delegated trace work, evidence gates, or multi-primitive exploit composition.

Route elsewhere:

- `decx-framework-vulnhunt`: `system_server`, framework jars, Binder services, OEM framework logic.
- `decx-cli`: command help only.
- `decx-report`: finalized report writing.
- `decx-poc`: PoC or verification artifact implementation.

Do not use this skill for generic Android security advice, raw source review without DECX state, standalone reports, framework/Binder hunts, or PoC coding.

## Instructions

1. **Prepare one APK target**: open or confirm one DECX APK session, choose a target directory, then initialize `.decx-analysis/<target>/decx-analysis.db`.
2. **Create bounded intents**: each intent must ask one concrete question, such as collecting a bounded surface, classifying one candidate group, tracing one source-to-sink path, validating one composition edge, or reviewing one evidence chain.
3. **Delegate target queries**: the main agent orchestrates only. Manifest, exported component, AIDL, dynamic receiver, resource, source, xref, method context, and search queries belong inside dispatched subagent intents. Session health checks and blackboard maintenance are allowed in the main context.
4. **Dispatch before claim**: every intent must be dispatched to exactly one subagent, then claimed by that subagent.
5. **Keep one intent per subagent invocation**: a subagent may write facts, events, links, chains, hints, and follow-up intents, but must not execute a second intent in the same invocation.
6. **Absorb evidence atomically**: prefer `result` to write subagent facts/events and close the intent. Use `link` or `chain` when multiple facts jointly prove the path.
7. **Promote only after review**: record candidate, promoted, or rejected events only after facts and links satisfy the promotion gate.
8. **Close composition before final output**: before ending analysis, review all promoted primitives and candidate chains for `enable`, `carry`, `amplify`, `bypass`, or `observe` edges. Dispatch one bounded composition-validation intent for each plausible pair or chain.
9. **Hand off deliverables**: after all intents are resolved and composition is closed, route reports to `decx-report` and PoC/verification artifact construction to `decx-poc`, unless the user explicitly requested analysis-only output.

## Blackboard

One SQLite database per target:

```bash
node scripts/decx-analysis-db.mjs init <dir> --session <name> --kind android_app
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

Use `references/index.md` as the authority for app-layer coverage and pattern routing.

- Start with `Composite Exploit Chains`; combined exploitability is the primary output goal.
- After surface enumeration, prioritize primitive pairs connected by `enable`, `carry`, `amplify`, `bypass`, or `observe`.
- Use `Single Pattern Routing` only when the observed code shape does not compose with another boundary and a `dead-end:` fact records why.
- Load references only when they add a routing signal, trace cue, promotion gate, or false-positive constraint for the current candidate.
- Stop loading more references when they only repeat generic Android security knowledge.

For each candidate, map:

- entrypoint signature and trigger syntax
- attacker precondition: local app, browser/deep link, malicious website, network attacker, malicious file/provider, notification/action trigger, or user interaction
- attacker-controlled fields: Intent, Bundle, Uri, ClipData, PendingIntent, Message, Parcel, WebView URL/HTML/JS, provider args, or file paths
- guard before trust boundary
- suspected sink family and impact hypothesis
- defensive control expected to block the path
- next DECX query or intent to create

Subagents must open helper bodies and prove exact branch outcomes. Method names are not evidence.

## Composition

Allowed edge types:

- `enable`: one primitive creates access needed by the next.
- `carry`: one primitive transports controlled data, grant, token, URI, PendingIntent, or WebView content.
- `amplify`: one primitive increases final impact.
- `bypass`: one primitive defeats the defense relied on by another path.
- `observe`: one primitive makes impact attacker-visible.

For each composed chain, record ordered stage ids, attacker preconditions, transferred object or control flow, trust boundary, bypassed defense, final impact, and why the chain is realistic.

Reject composition when stages are merely adjacent, require incompatible attacker positions, depend on unproven timing, require a victim action not represented in code, have no transferred object/control flow, hit a non-bypassable guard, or lack combined impact.

Record:

- `composition:` only after a dedicated subagent re-opens each stage, proves all edges, proves transferred object/control flow, and confirms exact branch outcomes under composed preconditions.
- `dead-end:` only for checked plausible compositions, naming tested stage ids, rejected edge type, and the concrete blocker.

## Promotion Gate

Promote only when all are proven as facts:

- external reachability
- attacker control
- guard outcome or bypass
- sink argument
- visible impact
- rating rationale from `references/risk-rating.md`
- evidence suitable for `decx-report`

For composed candidates, rate the final attacker-reachable impact after ordered stages compose, not the most severe isolated primitive. If composition is unproven, rate/report only the independently proven primitive impact or keep the record as candidate/residual.

Single-primitive findings are final only when composition is proven impossible or no plausible composition candidate exists.

## Command Reference

Use `decx-cli` as the authority for DECX command names, flags, identifier formats, and port/session behavior. If command syntax is uncertain, route command help to `decx-cli` or run the nearest `--help`; do not guess DECX syntax in this skill.

App-hunt-specific command rules:

- Main agent may open/check the APK session and maintain the blackboard; target inspection commands belong inside dispatched subagent intents.
- Session-backed `decx code` and `decx ard` queries must identify the intended session with `-P <port>` or `-s <name>` when more than one session exists.
- `all-resources` is an on-demand subagent query, not a required first-pass dump. Prefer focused resource queries when a candidate needs resource evidence.
- adb-backed commands such as `system-services`, `perm-info`, and `framework collect/process` are not app-hunt commands; when needed, follow `decx-cli` port rules.

## Examples

Example intent shapes:

- Collect exported Activity, Service, Receiver, Provider, deep-link, dynamic receiver, and AIDL surfaces for one APK.
- Classify one candidate group against `references/index.md` and create follow-up trace intents.
- Trace one exported entrypoint to one suspected sink, proving reachability, control, guard outcome, sink argument, and impact.
- Validate one plausible `carry` edge from a Provider URI grant to a private file disclosure path.
- Review one candidate chain against the promotion gate and `references/risk-rating.md`.

Example fact prefixes:

- `reachability: exported Activity "com.example.FooActivity" accepts action "..."`
- `control: extra "next_intent" reaches "startActivity(...)" argument`
- `guard: helper "checkCaller(...)" returns true for external caller when ...`
- `sink: controlled Uri reaches "openFile(...)" path argument`
- `impact: attacker can receive grant-bearing Uri via "setResult(...)"`
- `dead-end: stages 12,18 cannot compose because attacker preconditions are incompatible`

## Constraints

- Every intent must be dispatched to exactly one subagent before it is claimed.
- Main agent must not substitute direct target queries for recon or trace intents.
- Do not deep-trace multiple chains in one worker invocation.
- Do not scan every reference for one target.
- Method signatures must use full form: `"package.Class.method(paramType):returnType"`; never use `...`.
- Quote package names, classes, methods, and file paths.
- Do not report exported/reachable behavior without downstream impact.
- A nearby primitive is not a finding until reachability, attacker control, sink impact, and guard bypass are each proven.
- Do not close analysis until composition validation has been attempted for every plausible promoted primitive pair, or the main agent can demonstrate there is only one promoted primitive.
- Do not claim `poc-validated`, `runtime-validated`, `verified exploitable`, or equivalent.
- Hand off at 60% context usage with the target directory and active session name, not raw source dumps.
- Do not generate report templates, PoC code, or vulnerability descriptions inside this skill.

## Troubleshooting

| Symptom | Action |
|---|---|
| Missing or rejected command | Run the nearest `--help`. |
| Impact does not map to `risk-rating.md` | Keep evidence unverified; do not compose or promote. |
| Source reaches unknown helper | Open the helper body and prove the exact branch. |
| Reference adds no trace cue, promotion gate, or chain pivot | Stop using it. |
| Intent appears stuck | Check `intents --status open`; claim or fail stale intents. |
| Fact count grows without concluded intents | Run `stats`, find sources with no sink/impact facts, and create targeted intents. |

## Gotchas

- **Method-name inference**: helper names such as `validate*` or `check*` are not evidence. Open the body, prove the branch, and write a `guard:` fact.
- **Missing guard evidence**: a candidate without a proven guard outcome stays `candidate`.
- **Main-agent recon or tracing**: manifest, component, AIDL, resource, source, xref, method context, and search queries are subagent work.
- **Vague fact descriptions**: fact descriptions must identify the observation type and concrete evidence. Do not label attacker control as reachability or write sink facts without impact evidence.
- **Orphan intents**: intents without `--from <factId,...>` cannot be prioritized from the blackboard.
- **Incomplete path proof**: every hop needs facts for reachability, control, guard, sink, and impact as applicable.
- **Multiple claimed intents**: one subagent invocation handles one intent.
- **Reachability-only reporting**: exported components, reachable methods, or nearby sinks without downstream impact are reconnaissance, not findings.
- **Optional composition**: isolated promoted primitives are incomplete until plausible composition has been validated or rejected with `dead-end:` facts.

## References

- `references/index.md`
- `references/risk-rating.md`
- `references/overviews/*.md`
- `references/patterns/*.md`
- `references/casebooks/*.md`
