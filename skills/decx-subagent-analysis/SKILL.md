---
name: decx-subagent-analysis
description: DECX context analysis subagent. Use when decx-app-vulnhunt or decx-framework-vulnhunt needs one delegated context trace for a sourceId, sinkId or targetId, nextHop, method chain, guard, data-flow edge, or missing proof in an XML handoff artifact.
metadata:
  requires:
    bins: ["decx"]
---

# DECX Subagent Analysis

Use this skill only inside a parent DECX vuln-hunt workflow. The parent skill owns the workflow, session, and final decision. This subagent only analyzes assigned context and returns evidence.

## Instructions

Step 1: Read Assignment
- Confirm the parent skill, DECX port, target kind, `sourceId`, sink identifier, assigned `nextHop` or method signature, stop condition, and allowed files.
- Use the active `.decx-analysis/<target-name>/h_*.xml` handoff artifact as context.
- Require that XML to be created from the parent skill's `assets/decx-analysis-template.xml`.
- Treat `sourceId` as the source-chain id. In app artifacts, treat `sinkId` as the current known or suspected sink id and `flowSig` as the current class-level flow signature.
- Treat the XML as the context packet; do not accept raw chat summaries or source dumps as a substitute for the assigned XML.
- If the assignment asks for output generation or broad workflow planning, return a blocker.

Step 2: Analyze Context
- Follow only the assigned chain, guard, data-flow edge, or missing proof.
- Use DECX commands to inspect exact classes, methods, callers, callees, xrefs, resources, or manifests needed for that assignment.
- Stop at a sink, non-bypassable guard, dead end, proven next hop, or named missing proof.

Step 3: Return Evidence
- Return concrete method signatures, branch or guard outcome, attacker-controlled values, sink arguments, evidence locations, and unresolved proof gaps.
- Update only assigned XML fields when write access is allowed.
- If XML writing is unsafe, return a patch-ready summary instead of editing.

Step 4: Preserve Boundaries
- Do not close or restart the DECX session.
- Do not analyze unrelated chains discovered during the task.
- Record unrelated but relevant pivots only as `nextHop` or open questions.

## Examples

Example 1: Exported Activity Context
- Input: one `sourceId`, one sink id, one `nextHop.signature`, one controlled variable set
- Output: call chain, guard result, sink argument, evidence, and missing proof

Example 2: App Service Bind Context
- Input: one exported or bindable app Service target and one Binder/Messenger/AIDL entry
- Output: dispatch path, caller control, permission or identity guard, sensitive method, and next hop

Example 3: Framework Binder Context
- Input: one framework Binder method, one caller-controlled parameter set, and one privileged sink family
- Output: Binder reachability, caller control, permission/identity/user guard result, sink argument, and next hop

Example 4: Missing Proof Check
- Input: one unresolved guard, helper method, callback, or forwarded Intent edge
- Output: proven outcome or the exact reason proof is missing

## Constraints

- Do not restate the full app or framework vuln-hunt workflow here.
- Do not handle output generation or handoff work.
- Do not analyze multiple chains in one invocation.
- Do not write outside the assigned XML fields.
- Do not use older analysis or handoff templates.
- Do not close, restart, or replace the DECX session.
- Do not accept raw source dumps as a result.
- Every session-backed `decx code` and `decx ard` command must include `-P <port>`.
- adb-backed `system-services` and `perm-info` do not use `-P <port>`.

## Troubleshooting

- Assignment is too broad -> return a blocker and request one sourceId, sink id, nextHop, or proof gap.
- Evidence is only theoretical -> return `candidate` with missing proof; do not promote.
- Another chain appears -> record it as `nextHop`; do not expand scope.
- XML write conflict -> return a patch-ready summary instead of overwriting.
- Command is missing or rejected -> run the nearest `--help` command before retrying.
