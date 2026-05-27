---
name: decx-app-vulnhunt
description: Android app vulnerability hunting with DECX CLI. Use when the user asks to audit an APK, enumerate exported/deep-link/WebView/IPC/provider/receiver attack surface, trace exploitability, or produce XML analysis artifacts for report or PoC handoff.
metadata:
  requires:
    bins: ["decx"]
---

# DECX - Android App Vulnerability Hunting

Use this skill for APK app-layer vulnerability analysis. Workflow state and final findings must use XML artifacts created from `assets/decx-analysis-template.xml`.

## Instructions

Step 1: Prepare Target
- Open or reuse one APK session.
- Create `.decx-analysis/<target-name>/`.
- Use `h_<sourceId>_<sinkId>_<flowSig>.xml` with `metadata.kind = handoff` for intermediate analysis artifacts.
- Use `r_<sourceId>_<sinkId>_<flowSig>.xml` with `metadata.kind = result` for finalized result artifacts.
- `sourceId` identifies the analysis-chain source.
- `sinkId` identifies the current known or suspected sink.
- `flowSig` is the current analyzed class-level signature; if one class contains multiple issues, keep them as multiple `result` entries in the same artifact.
- Create app artifacts with `node skills/decx-app-vulnhunt/assets/decx-artifact.mjs`.
- Route `system_server`, framework jars, Binder service implementations, and OEM framework logic to `decx-framework-vulnhunt`.

Step 2: Enumerate Attack Surface
- Enumerate every externally reachable app surface.
- Assign stable `sourceId` values to analysis-chain sources and `sinkId` values to known or suspected sinks.
- Record each reachable surface as an XML `result` or analyzed `call`.
- Include exported components, deep links, dynamic receivers, AIDL/Binder, WebView hosts, URI grants, PendingIntent paths, and provider authorities.

Step 3: Build Permission And Reachability Context
- Record manifest permissions, component permissions, provider read/write permissions, receiver permissions, grant flags, and custom permission definitions.
- Keep `signature` / `signatureOrSystem` paths in scope when ownership, forwarding, proxying, re-granting, or victim-identity reuse is still unresolved.

Step 4: Route To Knowledge Layer
- Load `references/index.md`, then `references/vulnerability-router.md`.
- Pick the smallest matching reference set from observed behavior.
- Load one component overview only when needed from `references/overviews/`.
- Load only one or two matching `references/patterns/*.md` cards for the active target.
- Load `references/casebooks/*.md` only when a pattern needs an exploit-shape example.

Step 5: First Pass Classification
- Set every target to `candidate`, `statically-supported`, or `rejected`.
- Use `candidate` when proof is incomplete.
- Use `rejected` only with explicit blocking evidence.

Step 6: Deep Trace One Chain At A Time
- For every deep-trace chain, create a new subagent through `decx-subagent-analysis`. This is mandatory.
- Before invoking the subagent, materialize the chain context with `decx-artifact.mjs` into `h_<sourceId>_<sinkId>_<flowSig>.xml` for the current class-level flow signature.
- Give the subagent exactly one chain, one `sourceId`, one `sinkId`, one `nextHop`, and that `h_<sourceId>_<sinkId>_<flowSig>.xml`.
- Do not analyze a deep chain in the main agent; the main agent only prepares context, dispatches, merges XML evidence, and decides final state.
- Follow attacker-controlled data through callees and boundaries.
- Continue through helpers, callbacks, IPC, WebView, providers, grants, results, and nested components.
- Stop only at a sink, non-bypassable guard, dead end, or named missing proof.
- Save active `sourceId`, `sinkId`, `flowSig`, analyzed calls, current `result`, and `nextHop` in XML.

Step 7: Finalize Findings
- Apply `references/risk-rating.md`.
- Promote only when reachability, controllability, deep trace, impact, guard evidence, rationale, and evidence are all present.
- Highest allowed state is `statically-supported`.

Step 8: Report Or PoC Handoff
- Pass finalized `r_<sourceId>_<sinkId>_<flowSig>.xml` artifacts to `decx-report`.
- For PoC handoff, fill the selected result's XML `poc` block and pass exactly one `pocReady` result to `decx-poc`.

Use `references/app-workflow.md` for phase commands, XML write rules, permission inventory, rejection checks, resume rules, and PoC handoff details.

## Examples

Example 1: Exported Activity
- Recon finds an exported Activity.
- Route through `vulnerability-router.md`, then `overviews/activity.md`.
- If extras are forwarded into another component, trace the receiver before judging.

Example 2: WebView Input
- Recon or search finds attacker-controlled URL/HTML reaching WebView code.
- Route through `overviews/webview.md`.
- Promote only if controlled content reaches bridge, cookie, file, native scheme, credential, or trusted-session impact.

Example 3: Bound Service
- Recon finds exported or bindable service behavior.
- Route through `overviews/service.md`.
- Trace Binder, AIDL, Messenger, or Intent dispatch to the sensitive method and guard.

## Constraints

- Every session-backed `decx code` and `decx ard` command must include `-P <port>`.
- adb-backed commands such as `system-services`, `perm-info`, and `framework collect/process` do not use `-P <port>`.
- Method signatures must use full form: `"package.Class.method(paramType):returnType"`.
- Never use `...` in signatures.
- Quote package names, classes, methods, and file paths.
- Do not use older analysis or handoff templates.
- Do not continue deep trace if `decx-subagent-analysis` cannot be invoked; report the blocker. Do not fall back to main-agent deep tracing.
- Do not scan every vulnerability reference for one target.
- Do not use legacy root-level `app_*` or `app-*` vulnerability files; the knowledge layer is `overviews/`, `patterns/`, `casebooks/`, and `risk-rating.md`.
- Do not deep-trace multiple chains in one subagent.
- Do not report exported/reachable behavior without downstream impact.
- Do not claim `poc-validated`, `runtime-validated`, or equivalent.
- Hand off at 60% context usage with the active `h_<sourceId>_<sinkId>_<flowSig>.xml` and any finalized `r_<sourceId>_<sinkId>_<flowSig>.xml`, not raw source dumps.

## Troubleshooting

- Missing or rejected command -> run the nearest `--help` command before retrying.
- Impact does not map to `risk-rating.md` -> keep `candidate` or `rejected`; do not promote.
- Source reaches helper name but body is unknown -> open the helper and prove the exact branch outcome.
- Reference adds no trace cue, promotion gate, or chain pivot -> stop using it for this target.

## References

- `references/index.md`
- `references/app-workflow.md`
- `references/vulnerability-router.md`
- `references/risk-rating.md`
- `references/overviews/*.md`
- `references/patterns/*.md`
- `references/casebooks/*.md`
