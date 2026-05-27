# Framework VulnHunt Workflow Reference

## Contents

- [Phase 1 - Prepare Target](#phase-1---prepare-target)
- [Phase 2 - Recon](#phase-2---recon)
- [Phase 3 - Permission And Identity Context](#phase-3---permission-and-identity-context)
- [Phase 4 - Route And First Pass](#phase-4---route-and-first-pass)
- [Phase 5 - Per-Service Analysis](#phase-5---per-service-analysis)
- [Phase 6 - Cross-Service Analysis](#phase-6---cross-service-analysis)
- [Phase 7 - Exploitability Filter](#phase-7---exploitability-filter)
- [Phase 8 - Report Or PoC Handoff](#phase-8---report-or-poc-handoff)
- [Handoff And Resume](#handoff-and-resume)

## Phase 1 - Prepare Target

Fastest path:

```bash
decx ard framework run --serial <serial> -P <port>
```

Artifact-retaining path:

```bash
decx ard framework collect --serial <serial>
decx ard framework process <oem>
decx ard framework open -P <port>
```

Existing final bundle:

```bash
decx ard framework open "<framework-jar-path>" -P <port>
decx process status -P <port>
```

Rules:

- Start here before code tracing.
- Prefer `framework run` for fastest device-to-session flow.
- Prefer `collect` -> `process` -> `open` when artifact retention or output-directory control matters.
- `framework process` takes `<oem>` as its only positional argument; pass source/output locations with `--source-dir` and `--out-dir` only when needed.
- `framework open` opens a generated or provided jar and does not take `--serial`.
- Reuse the generated `framework_<oem>_<vendor>.jar` session name when possible.
- If no device is connected and no final framework bundle is provided, stop and ask for one.
- Do not close the session automatically; tell the user they can close it with `decx process close "<name>"`.

## Phase 2 - Recon

Goal: enumerate the framework attack surface and return a minimal structured shortlist.

Execution model:

- If subagents are explicitly allowed, create one recon subagent.
- If subagents are not allowed, run the same recon steps in the main agent.
- Persist `h_<sourceId>_<sinkId>_<flowSig>.xml` with `metadata.kind = handoff` before deep tracing when interruption-safe analysis matters.
- `sourceId` is the stable id assigned to the analysis-chain source.
- `sinkId` is the stable id assigned to the current known or suspected sink.
- `flowSig` is the current analyzed class-level service, interface, manager, or method-owner signature; the file name uses a sanitized form, while XML keeps the original signature.
- If one class contains multiple issues, write multiple `result` entries in the same artifact instead of creating duplicate class-level artifacts.
- One source chain can create multiple intermediate `h_...xml` files as the trace crosses services, managers, Binder boundaries, or class-level owners.
- Do not add sequence fields for ordering. Use existing `analysis.depth`, `analyzedChains`, `beforeHop`, and `nextHop` to express progress.
Use `node skills/decx-framework-vulnhunt/assets/decx-artifact.mjs <target-dir> <source-sig> <sink-sig> <flow-sig> <session> <kind>` to create artifacts.

Start anchors:

- `decx ard system-services --serial <serial> --grep <keyword>`
- `decx ard system-service-impl "<interface>" -P <port>`
- `decx code implement "<interface>" -P <port>`
- `decx code search-method "<methodName>" -P <port>` only if the Binder entrypoint name is still unknown

Recon rules:

- Build the shortlist around Binder service name, AIDL interface, Stub implementation, manager facade, and privileged sink families.
- Use concrete service family names as the first `--grep` filter before broadening scope.
- Treat the open final framework bundle as the only codebase under review.
- Use `system-services` and `perm-info` as support evidence, not substitutes for code tracing.
- Consume `system-services.services[].name` and `interfaces[]` directly from parsed command output.
- Resolve permission levels with `decx ard perm-info "<permission>" --serial <serial>`.
- Only `needsAnalysis: true` targets move to Phase 3.

## Phase 3 - Permission And Identity Context

Goal: record access-control context before deciding whether a service path is reachable or blocked.

Collect for each retained target:

- declared or enforced permissions
- `perm-info.protectionLevel` for referenced permissions
- app-op checks
- Binder caller UID and package binding
- user/profile ownership checks
- `clearCallingIdentity` / restore windows
- caller-controlled package, UID, user, `Intent`, `Uri`, `Bundle`, or token parameters
- async callbacks, pending work, and identity captured across boundaries

Do not reject a path until the relevant permission, UID/package, user/profile, identity, and lower-level callee checks are traced.

## Phase 4 - Route And First Pass

Goal: pick the correct knowledge reference and classify every retained target without losing coverage.

Load order:

1. `references/overviews/service.md`
2. one or two matching `references/patterns/*.md` cards
3. `references/casebooks/framework-service-cases.md` only for comparable exploit-chain shapes
4. `references/risk-rating.md` only after sink, blocker, or missing proof is known

Allowed states:

- `candidate`: suspicious path exists but proof is incomplete
- `statically-supported`: static evidence supports reachability, control, bypassability, and visible impact
- `rejected`: unreachable, uncontrollable, blocked, or not impactful

Every rejection needs explicit blocker evidence.

## Phase 5 - Per-Service Analysis

Goal: upgrade retained targets to `statically-supported` or downgrade them to `rejected`, while keeping current source component, issue type, chain progress, and next follow-up targets explicit.

Core loop:

- Map runtime surface with `decx ard system-services --serial <serial> --grep <keyword>`.
- Use `interfaces[]` to choose the relevant Binder contract.
- Resolve implementation with `decx ard system-service-impl "<interface>" -P <port>`.
- Pair permission-gated traces with `decx ard perm-info "<permission>" --serial <serial>`.
- Prefer exact interface names from `system-services.interfaces[]`; do not invent Binder names by hand.

Subagent rule:

- Per-service deep trace must be delegated to `decx-subagent-analysis`.
- The main agent must not deep-trace the method chain itself.
- Before dispatch, create or update `.decx-analysis/<target-name>/h_<sourceId>_<sinkId>_<flowSig>.xml` with `decx-artifact.mjs`.
- The XML is the context packet: it must contain `sourceId`, `sinkId`, `flowSig`, session, service/interface entrypoint, tainted variables, analyzed calls, current result, `nextHop`, and stop condition.
- Pass only that XML path plus the assigned method chain to the subagent.
- If the subagent cannot be invoked, stop the deep trace and record the blocker in the XML.

Primary command:

```bash
decx code method-context "<currentMethod>" -P <port>
```

Use `method-source` only when the full body is required.

Method labels:

- `SOURCE`: attacker-controlled Binder or manager input enters here
- `SINK`: privileged service action happens here
- `SAFE`: non-bypassable guard exists here
- `PASS_THROUGH`: keep tracing
- `DEAD_END`: no further value

Common sources:

- AIDL or Binder params
- `Parcel` fields decoded from transactions
- manager facade arguments forwarded into a service
- attacker-controlled package names, UIDs, user IDs, Intents, URIs, or Bundles

Common sinks:

- privileged file, settings, package, account, telecom, notification, or user-state operations
- cross-user reads or writes
- privileged activity or service launches
- identity transitions around `clearCallingIdentity`
- hidden API or system-only operations exposed to an untrusted caller

Common non-bypassable guards:

- `enforceCallingPermission`, `checkCallingPermission`, `enforceCallingOrSelfPermission`
- exact signature or UID enforcement
- immutable allowlists tied to trusted platform packages
- explicit caller-user ownership checks that cannot be attacker-influenced

Minimum finding fields:

- `findingId`
- `sourceId`
- `sourceId`
- `sinkId`
- `type`
- `risk`
- `serviceName`
- `interface`
- `entryPoint`
- `source`
- `sink`
- `callChain`
- `guards`
- `bypass`
- `impact`
- `rating`
- `rationale`
- `evidence`
- `pocReady`

## Phase 6 - Cross-Service Analysis

Continue only when:

- the chain crosses a Binder boundary, manager facade, or internal service helper
- downstream reachability must be confirmed
- identity, grant, or user-selection state crosses trust boundaries
- permission delegation, async callback state, or scheduled work changes the trust boundary

Rules:

- Cross-service deep trace must also be delegated to `decx-subagent-analysis`.
- Reuse `nextMethods` from the previous phase.
- Inherit the existing `chain`.
- Keep the same minimal finding schema.
- Persist retained targets and findings incrementally in `h_<sourceId>_<sinkId>_<flowSig>.xml`. If the same source chain moves into another service, manager, Binder boundary, class-level owner, or different sink, create another `h_...xml` with the same `sourceId` and the new `sinkId` or `flowSig`.

## Phase 7 - Exploitability Filter

This phase is exploitability triage based on the traced chain, not exploitation proof.

Quick rejection checks:

| Condition | Check |
|----------|-------|
| `signature` or `signatureOrSystem` permission | `perm-info.protectionLevel` |
| exact signature enforcement | `checkSignatures`, platform-signer compare |
| hard package or UID allowlist | immutable trusted allowlist |
| root or system-only path | privileged-only API or environment |
| non-bypassable guard on source-to-sink path | permission, ownership, identity, cryptographic, or strict type guard |

Framework-specific rules:

- Treat `signature` and `signatureOrSystem` permissions as protected unless access is forwarded or capability is re-granted.
- If the gating permission is missing from runtime resolution, custom, or not provably signature-bound, keep the finding at `candidate` unless bypass conditions are explicit.
- If `system-services` shows no matching Binder service on the connected device, downgrade runtime-reachability confidence.

Decision rules:

- Reachable + controllable + impactful + bypass conditions + impact evidence: `statically-supported`
- Any factor missing with explicit blocking evidence: `rejected`
- Suspicious but incomplete: `candidate`

## Phase 8 - Report Or PoC Handoff

Hand finalized result artifacts to `decx-report`.

Requirements:

- XML coverage and every retained target judgement are current.
- Supported findings include `callChain`, `guards`, `bypass`, `impact`, `rating`, `rationale`, and `evidence`.
- Full reports and single-finding reports are generated by `decx-report`.
- Each supported finding is written to `r_<sourceId>_<sinkId>_<flowSig>.xml` with `metadata.kind = result`.
- For PoC handoff, fill exactly one selected result's XML `poc` block and mark it `pocReady`; do not create a separate handoff file.

## Handoff And Resume

At 60% context usage, hand off by saving the current `h_<sourceId>_<sinkId>_<flowSig>.xml` and any finalized `r_<sourceId>_<sinkId>_<flowSig>.xml`.

The XML must contain enough continuation state to resume:

- `sinkId`
- `decxSession`
- `entrypoint`
- current `depth`
- `taintedVariables`
- completed `analyzedChains`
- active `result`
- active `nextHop`

Resume:

1. Load the active `h_<sourceId>_<sinkId>_<flowSig>.xml`.
2. Verify target, artifact directory, session, port, and serial.
3. Check the active `sourceId`, `sinkId`, analyzed calls, and `nextHop`.
4. Reconfirm the DECX session with `decx process status -P <port>`.
5. Continue from the active XML result and `nextHop`.
