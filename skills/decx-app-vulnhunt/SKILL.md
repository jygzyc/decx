---
name: decx-app-vulnhunt
description: Android APK vulnerability hunting with DECX. Use for APK exported/deep-link/WebView/Provider/Receiver/Service/app-IPC attack-surface analysis, exploitability tracing, XML result artifacts, report handoff, or PoC readiness.
metadata:
  requires:
    bins: ["decx"]
---

# DECX - Android App Vulnerability Hunting

Use for APK app-layer vulnerability analysis only. Route `system_server`, framework jars, Binder service implementations, and OEM framework logic to `decx-framework-vulnhunt`. Route command help only to `decx-cli`, report writing to `decx-report`, and PoC implementation to `decx-poc`.

## Routing Gate

Use only when DECX app-layer artifact rules matter: APK session binding, app attack-surface routing, XML handoff/result artifacts, subagent chain tracing, evidence gates, or multi-primitive app exploit composition. Do not use for generic Android security advice, raw source review without DECX state, framework/Binder hunts, standalone reports, or PoC coding.

## Critical Contract

- Use only current XML artifacts from `assets/decx-analysis-template.xml`.
- Session handoff: `.decx-analysis/<target>/h_<sessionName>.xml`.
- Chain handoff: `.decx-analysis/<target>/h_<sourceId>_<sinkId>_<flowSig>.xml`.
- Final result: `.decx-analysis/<target>/r_<sourceId>_<sinkId>_<flowSig>.xml`.
- `sourceId` and `sinkId` are stable base64url ids produced by `assets/decx-artifact.mjs`; `flowSig` is the current analyzed component signature for the analysis chain.
- Use `h_<sessionName>.xml` only for collection/candidate pool context. Use chain-level `h_*.xml` only after source, sink, and flow are known.
- Do not reintroduce `decx-analysis.xml` or recon/coverage/findings/resume JSON.

```bash
node skills/decx-app-vulnhunt/assets/decx-artifact.mjs <target-dir> "" "" "" <session> handoff-session
node skills/decx-app-vulnhunt/assets/decx-artifact.mjs <target-dir> <source-sig> <sink-sig> <flow-sig> <session> <handoff|result>
```

## Workflow

1. **Prepare**: open one APK session and create `h_<sessionName>.xml`.
2. **Collect**: enumerate manifest, components, deep links, receivers, AIDL, resources, WebView hosts, provider authorities, URI grants, and PendingIntent paths.
3. **Model attack surface**: group candidates by attacker capability, entrypoint, trust boundary, controlled object, guard, suspected sink, and defensive control.
4. **Route knowledge**: use `references/index.md`; load one overview, one or two pattern cards, and casebooks only for matching exploit shapes.
5. **Classify**: set each candidate to `candidate`, `statically-supported`, or `rejected`; every rejection needs blocker evidence.
6. **Deep trace**: delegate exactly one chain per `decx-subagent` invocation. Main agent must not deep-trace.
7. **Compose**: combine primitives only when evidence proves an object, identity, data, grant, token, or control-flow transfer between stages.
8. **Finalize**: promote only findings with reachability, controllability, guard/bypass, sink, impact, rating rationale, and report-ready evidence.
9. **Handoff**: write promoted findings to `r_*.xml`; fill one selected result `poc` block and `pocReady` only when PoC trigger and success signal are explicit.

## Required DECX Commands

```bash
decx process list
decx process open "<apk-path>" --name "<target-name>" -P <port>
decx process status "<target-name>" -P <port>
decx ard app-manifest -P <port>
decx ard exported-components -P <port>
decx ard app-deeplinks -P <port>
decx ard app-receivers -P <port>
decx ard get-aidl -P <port>
decx ard all-resources -P <port>
```

## Candidate Map Fields

- entrypoint signature and trigger syntax
- attacker precondition: local app, browser/deep link, malicious website, network attacker, malicious file/provider, notification/action trigger, or user interaction
- attacker-controlled fields: Intent, Bundle, Uri, ClipData, PendingIntent, Message, Parcel, WebView URL/HTML/JS, provider args, or file paths
- guard before trust boundary
- suspected sink family and impact hypothesis
- defensive control expected to block the path
- next DECX query or subagent task

## Deep Trace Rules

- Before dispatch, create/update chain-level `h_<sourceId>_<sinkId>_<flowSig>.xml`.
- Pass only the XML path plus one assigned chain to `decx-subagent`.
- Stop if the subagent cannot be invoked; record blocker.
- Trace helpers, callbacks, IPC, WebView navigation, providers, URI grants, `setResult`, PendingIntent execution, nested components, async handlers, and Binder boundaries.
- Open helper bodies and prove branch outcomes. Do not infer from method names.
- If a target returns data or grants, trace the caller-visible result path as impact evidence.
- Stop only at sink, non-bypassable guard, dead end, or named missing proof.

## Composition Rules

Allowed edges:

- `enable`: one primitive creates access needed by the next.
- `carry`: one primitive transports controlled data, grant, token, URI, PendingIntent, or WebView content.
- `amplify`: one primitive increases final impact.
- `bypass`: one primitive defeats the defense relied on by another path.
- `observe`: one primitive makes impact attacker-visible.

For each composed chain, record ordered stage ids, attacker preconditions, transferred object/control flow, trust boundary, bypassed defense, final impact, and why the chain is realistic. Reject composition when stages are merely adjacent, require incompatible attacker positions, depend on unproven timing, or require a victim action not represented in code.

## Promotion Gate

Promote only when all are proven:

- external reachability
- attacker control
- guard outcome or bypass
- sink argument
- visible impact
- rating rationale from `references/risk-rating.md`
- evidence suitable for `decx-report`

For composed chains, distinguish primitive evidence, composition-edge evidence, combined impact, controls that break the chain, and residual uncertainty.

## Constraints

- Every session-backed `decx code` and `decx ard` command must include `-P <port>`.
- adb-backed commands such as `system-services`, `perm-info`, and `framework collect/process` do not use `-P`.
- Method signatures must use full form: `"package.Class.method(paramType):returnType"`; never use `...`.
- Quote package names, classes, methods, and file paths.
- Do not scan every reference for one target.
- Do not deep-trace multiple chains in one subagent.
- Do not report exported/reachable behavior without downstream impact.
- A nearby primitive is not a finding until reachability, attacker control, sink impact, and guard bypass are each proven.
- Do not claim `poc-validated`, `runtime-validated`, `verified exploitable`, or equivalent.
- Hand off at 60% context usage with active XML artifacts, not raw source dumps.

## Troubleshooting

- Missing/rejected command -> run nearest `--help`.
- Impact does not map to `risk-rating.md` -> keep `candidate` or `rejected`.
- Source reaches unknown helper -> open helper and prove exact branch.
- Reference adds no trace cue, promotion gate, or chain pivot -> stop using it.

## References

- `references/index.md`
- `references/risk-rating.md`
- `references/overviews/*.md`
- `references/patterns/*.md`
- `references/casebooks/*.md`
