---
name: decx-subagent
description: DECX XML artifact subagent. Use when decx-app-vulnhunt, decx-framework-vulnhunt, or decx-poc delegates exactly one XML-backed chain trace, result review, sink check, guard check, nextHop, or PoC sink re-verification.
metadata:
  requires:
    bins: ["decx"]
---

# DECX Subagent Analysis

Use this skill only as a delegated worker for a parent DECX skill. The parent owns scope, workflow, reporting, PoC construction, and final promotion. This subagent consumes one XML artifact and returns evidence for one selected `result`.

## Routing Gate

Use only when a parent DECX skill delegates exactly one XML-backed chain trace, guard/sink check, next-hop check, result review, or PoC sink re-verification. Do not use directly for full vulnerability hunts, collection planning, report writing, PoC implementation, generic code review, or multiple artifacts/results/chains. If no single XML artifact and selected result/stop condition are provided, return a blocker instead of broadening scope.

Supported parents: `decx-app-vulnhunt`, `decx-framework-vulnhunt`, and `decx-poc`.

## Instructions

Step 1: Read Metadata
- Accept only one `.decx-analysis/<target>/h_<sessionName>.xml`, `h_<sourceId>_<sinkId>_<flowSig>.xml`, or `r_<sourceId>_<sinkId>_<flowSig>.xml`.
- Reject raw chat summaries, raw source dumps, old `decx-analysis.xml`, JSON handoff files, or multiple XML artifacts as substitutes.
- Read `metadata.kind`, `metadata.sourceId`, `metadata.sinkId`, `metadata.flowSig`, `metadata.fileName`, and `metadata.decxSession`.
- If source or sink signature is unclear, decode ids from the artifact file name:

```bash
node skills/decx-subagent/scripts/decode-artifact-name.mjs "<artifact-path>"
```

- `h_<sessionName>.xml` means session collection/candidate pool context; do not infer source/sink from the file name.
- `h_<sourceId>_<sinkId>_<flowSig>.xml` means chain trace context; source and sink can be decoded from the file name if XML fields are incomplete.
- `kind = result` means only review the selected finalized result; do not discover or add unrelated findings.

Step 2: Read Context
- Read `context.entrypoint`, `context.analysis`, `taintedVariables`, and `analyzedChains/call`.
- Use `context.information` only as support, not proof.
- Treat `sourceId` as chain source, `sinkId` as current known/suspected sink, and `flowSig` as current analyzed component signature for the analysis chain.
- For session handoff, use `context.analysis`, `context.information`, and `results/result` as the candidate pool.

Step 3: Select One Result
- Select exactly one `results/result` assigned by the parent.
- Read `trigger`, `type`, `signature`, `status`, `impact`, `rating`, `beforeHop`, `nextHop`, `evidence`, `missingProof`, `blocker`, `rationale`, `pocReady`, and `poc`.
- If the parent did not identify which result to review and the XML contains multiple results, return a blocker.
- Do not analyze multiple chains, multiple results, or multiple stop conditions in one invocation.

Step 4: Analyze By Result Type
- `entrypoint`: prove whether the entrypoint is externally or Binder reachable and whether the assigned source is reachable from it.
- `source`: prove attacker control of the assigned variable, argument, field, URI, Intent, Bundle, Binder parameter, WebView input, or provider argument.
- `guard`: prove the exact branch outcome for permission, UID/package, signature, app-op, user/profile, allowlist, validation, or identity guard.
- `pass-through`: prove whether tainted data crosses the assigned method, callback, IPC, async, provider, WebView, Intent, or helper boundary.
- `sink`: prove whether the assigned source reaches the sink argument and whether the sink has visible security impact.
- `dead-end`: prove the exact reason the path cannot continue.

Stop only at `nextHop.stopWhen`: `sink`, `blocking-guard`, `dead-end`, or `next-hop`.

Step 5: Return Or Update XML Fields
- Return concrete method signatures, branch outcomes, attacker-controlled values, sink arguments, evidence locations, and unresolved proof gaps.
- When write access is allowed and there is no conflict, update only the selected result fields: `evidence`, `missingProof`, `blocker`, `rationale`, `beforeHop`, `nextHop`, and `status`.
- For session `kind = handoff`, write collection/candidate pool evidence using existing result types only: `entrypoint`, `source`, `guard`, `pass-through`, `sink`, or `dead-end`. Do not invent `collection` as a result type and do not promote final findings.
- For chain `kind = handoff`, allowed statuses are `candidate`, `statically-supported`, and `rejected`.
- For `kind = result`, do not promote a rejected/candidate result; only confirm, downgrade, or record blockers for the selected finalized result.
- If XML writing is unsafe, return a patch-ready summary instead of editing.

## PoC Sink Re-Verification

Use this mode only when parent is `decx-poc` and `metadata.kind = result`.

Required checks:

1. The selected result has `status = statically-supported` and `pocReady = true`.
2. `poc.trigger` still maps to the same entrypoint/source shape.
3. `poc.steps` cover the shortest attacker action sequence needed to reach the verified sink.
4. `result.signature` or the assigned sink is still reachable from `context.entrypoint`.
5. Existing guard evidence still shows no missed non-bypassable guard.
6. `poc.successSignal` corresponds to a real observable effect from `impact`, not a theory statement.
7. `poc.requirements` contain only required setup.

Return `blocker` and stop if the sink is unreachable, the guard is non-bypassable, the `poc` block is incomplete, or the XML contradicts current DECX source.

Do not write exploit code, create a PoC project, compile, deploy, run adb validation, or claim `runtime-validated` / `poc-validated`.

## Constraints

- Do not restate or run the full app, framework, report, or PoC workflow.
- Do not handle report generation, PoC construction, compile, deployment, or runtime validation.
- Do not analyze multiple XML artifacts, results, chains, or stop conditions in one invocation.
- Do not write outside the selected result fields.
- Do not use older analysis or handoff templates.
- Do not close, restart, or replace the DECX session.
- Do not accept raw source dumps as a result.
- Every session-backed `decx code` and `decx ard` command must include `-P <port>`.
- adb-backed `system-services`, `perm-info`, and `framework collect/process` do not use `-P <port>`.
- If a command is missing, rejected, or uncertain, run the nearest `--help` command before retrying.

## Troubleshooting

- Assignment is too broad -> return a blocker requesting one XML path, one selected result, and one stop condition.
- XML contains multiple results but no selection -> return a blocker.
- Evidence is only theoretical -> keep or return `candidate` with `missingProof`; do not promote.
- Sink is not reachable during PoC re-verification -> set or return `blocker` and stop PoC construction.
- Another chain appears -> record it as `nextHop`; do not expand scope.
- XML write conflict -> return a patch-ready summary instead of overwriting.
