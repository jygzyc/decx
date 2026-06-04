---
name: decx-framework-vulnhunt
description: Android framework vulnerability hunting with DECX. Use for processed framework bundles, system_server, Binder services, AIDL implementations, vendor/OEM framework code, and privileged framework IPC exploitability tracing.
metadata:
  requires:
    bins: ["decx"]
---

# DECX - Android Framework Vulnerability Hunting

Use for static framework and Binder-service vulnerability hunting only. Route APK exported components, app Providers/Receivers/Services, deep links, WebView hosts, and app-layer IPC to `decx-app-vulnhunt`. Route command help only to `decx-cli`, report writing to `decx-report`, and PoC implementation to `decx-poc`.

## Routing Gate

Use only when DECX framework artifact rules matter: final processed framework target, Binder/service attack-surface routing, caller identity evidence, XML handoff/result artifacts, subagent chain tracing, or multi-primitive framework exploit composition. Do not use for APK app-layer flows, generic Android security advice, raw source review without DECX state, standalone reports, or PoC coding.

## Critical Contract

- Analyze exactly one processed final framework bundle. Do not proactively switch to split jars under `source/`.
- If only raw framework inputs exist, collect/process first, then open the final bundle.
- Use only current XML artifacts from `assets/decx-analysis-template.xml`.
- Session handoff: `.decx-analysis/<target>/h_<sessionName>.xml`.
- Chain handoff: `.decx-analysis/<target>/h_<sourceId>_<sinkId>_<flowSig>.xml`.
- Final result: `.decx-analysis/<target>/r_<sourceId>_<sinkId>_<flowSig>.xml`.
- `sourceId` and `sinkId` are stable base64url ids produced by `assets/decx-artifact.mjs`; `flowSig` is the current analyzed component signature for the analysis chain.
- Use `h_<sessionName>.xml` only for collection/candidate pool context. Use chain-level `h_*.xml` only after source, sink, and flow are known.
- Do not reintroduce `decx-analysis.xml` or recon/coverage/findings/resume JSON.

```bash
node skills/decx-framework-vulnhunt/assets/decx-artifact.mjs <target-dir> "" "" "" <session> handoff-session
node skills/decx-framework-vulnhunt/assets/decx-artifact.mjs <target-dir> <source-sig> <sink-sig> <flow-sig> <session> <handoff|result>
```

## Workflow

1. **Prepare**: open one processed framework target and create `h_<sessionName>.xml`.
2. **Collect**: enumerate live services, implementations, AIDL/Stub paths, manager facades, privileged sinks, permissions, app-ops, UID/package/user checks, identity-clearing paths, cross-service calls, provider proxies, PendingIntent paths, and framework Intent launches.
3. **Model attack surface**: group Binder methods by caller capability, service facade, trust boundary, controlled object, guard, suspected sink, and defensive control.
4. **Route knowledge**: use `references/index.md`; load service overview, one or two pattern cards, and casebook only for matching exploit shapes.
5. **Classify**: set each candidate to `candidate`, `statically-supported`, or `rejected`; every rejection needs blocker evidence.
6. **Deep trace**: delegate exactly one chain per `decx-subagent` invocation. Main agent must not deep-trace.
7. **Compose**: combine primitives only when evidence proves object, identity, token, user, or control-flow transfer between stages.
8. **Finalize**: promote only findings with caller reachability, controllability, guard/bypass, identity state, sink, impact, rating rationale, and report-ready evidence.
9. **Handoff**: write promoted findings to `r_*.xml`; fill one selected result `poc` block and `pocReady` only when caller setup, trigger, and success signal are explicit.

## Required DECX Commands

```bash
decx ard framework collect --adb-path "<adb>" --serial "<serial>" --out "<raw-dir>"
decx ard framework process "<raw-dir>" --out "<processed-dir>"
decx ard framework run "<processed-framework-dir>" --name "<target-name>" -P <port>
decx ard framework open "<final-framework-jar>" --name "<target-name>" -P <port>
decx process status "<target-name>" -P <port>
decx ard system-services --adb-path "<adb>" --serial "<serial>"
decx ard perm-info "<permission>" --adb-path "<adb>" --serial "<serial>"
decx ard system-service-impl "<InterfaceOrService>" -P <port>
decx code search-global "extends Binder" -P <port>
decx code search-global "clearCallingIdentity" -P <port>
```

## Candidate Map Fields

- Binder/service entrypoint signature and service name
- attacker precondition: unprivileged app, same UID/package claim, work profile/cross-user caller, shell/adb-only caller, malicious provider/URI, malicious PendingIntent, or user interaction
- attacker-controlled parameters: package, UID, userId, attribution, token, URI, Intent, Bundle, Parcel, PendingIntent, file path, or callback
- guard before privileged trust boundary
- suspected privileged sink and impact hypothesis
- defensive control expected to block the path
- next DECX query or subagent task

## Deep Trace Rules

- Before dispatch, create/update chain-level `h_<sourceId>_<sinkId>_<flowSig>.xml`.
- Pass only the XML path plus one assigned chain to `decx-subagent`.
- Stop if the subagent cannot be invoked; record blocker.
- Trace manager facades, Binder Stubs, permission helpers, app-op helpers, identity-clearing blocks, cross-user helpers, provider proxies, PendingIntent creation/dispatch, privileged Intent launches, async handlers, callbacks, tokens, and cross-service Binder calls.
- Open helper bodies and prove branch outcomes. Do not infer from method names.
- When identity is cleared, prove all attacker-controlled work inside the cleared scope was authorized before clearing.
- Stop only at sink, non-bypassable guard, dead end, or named missing proof.

## Composition Rules

Allowed edges:

- `enable`: one primitive creates access needed by the next.
- `carry`: one primitive transports UID, package, user, URI, Intent, token, PendingIntent, or Binder state.
- `amplify`: one primitive increases final framework/system impact.
- `bypass`: one primitive defeats permission, app-op, identity, user, or callee defense.
- `observe`: callback, broadcast, result receiver, provider query, or launched Intent makes impact visible.

For each composed chain, record ordered stage ids, caller identity per stage, transferred object/identity/control flow, trust boundary, bypassed defense, final impact, and why the chain is realistic. Reject composition when stages are adjacent only, require incompatible caller identities, depend on unproven race timing, lose Binder identity between stages, or require privileged setup outside the code path.

## Promotion Gate

Promote only when all are proven:

- Binder/service reachability
- attacker-controlled parameter or object
- exact permission/app-op/UID/package/user/identity branch outcome
- sink argument
- visible framework/system impact
- rating rationale from `references/risk-rating.md`
- evidence suitable for `decx-report`

For composed chains, distinguish primitive evidence, composition-edge evidence, combined impact, controls that break the chain, and residual uncertainty.

## Constraints

- Analyze one final framework code target per hunt; stop and ask if given only split `source/` jars.
- Every session-backed `decx code` and `decx ard` command must include `-P <port>`.
- adb-backed `system-services`, `perm-info`, and `framework collect/process` do not use `-P`.
- Method signatures must use full form: `"package.Class.method(paramType):returnType"`; never use `...`.
- Quote package names, classes, methods, interfaces, Binder names, and file paths.
- If command syntax is uncertain, run nearest `--help`.
- Do not scan every reference for one target.
- Do not deep-trace multiple chains in one subagent.
- Do not report reachable Binder behavior without downstream impact.
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
