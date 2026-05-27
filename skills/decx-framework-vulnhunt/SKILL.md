---
name: decx-framework-vulnhunt
description: Use when hunting Android framework vulnerabilities in a processed final framework bundle, `system_server`, Binder services, AIDL implementations, vendor services, or OEM framework code.
metadata:
  requires:
    bins: ["decx"]
---

# DECX CLI - Android Framework Vulnerability Hunting

Use this skill for static framework and Binder-service vulnerability hunting.

Scope:

- In scope: processed final framework bundle analysis, Binder service enumeration, AIDL and Stub tracing, permission-gate review, exploitability triage, analysis handoff
- Out of scope: APK entry-surface hunting, PoC construction, runtime confirmation, proactive analysis of split jars under `source/`
- Use `decx-app-vulnhunt` for APK surfaces and `decx-poc` for PoC or runtime validation
- Highest allowed conclusion: `statically-supported`
- Never claim `poc-validated`, `runtime-validated`, `verified exploitable`, or equivalent
- Command reference lives in `decxcli`

## Hard Rules

- Analyze exactly one framework code target per hunt: the processed final framework bundle such as `framework_<oem>_<vendor>.jar` or a user-provided equivalent final bundle.
- Do not proactively open, trace, compare, or switch to split framework jars under `source/` as separate DECX targets.
- If the only available path points to `source/` or another split jar, stop and ask for the processed final bundle.
- Route exported Activities, Providers, Receivers, app Services, deep links, or WebView hosts to `decx-app-vulnhunt`.
- Every session-backed `decx code` command and session-backed `decx ard` command must include `-P <port>`.
- adb-backed `decx ard` commands such as `system-services`, `perm-info`, `framework collect`, and `framework process` do not use `-P <port>`.
- `decx ard framework run` and `decx ard framework open` use `-P <port>` only when they open a DECX session.
- Method signatures must use full format: `"package.Class.method(paramType):returnType"`.
- Never use `...` in signatures.
- Quote package names, class names, method signatures, interfaces, Binder names, and file paths.
- If a command is missing, rejected, or uncertain, run the nearest `--help` command before retrying.
- For every per-service or cross-service deep trace chain, create a `decx-subagent-analysis` subagent. Do not deep-trace the chain in the main agent.
- Hand off at 60% context usage; keep structured summaries, not raw source dumps.

## Persistence

Use `.decx-analysis/<target-name>/`.

Artifacts:

- `h_<sourceId>_<sinkId>_<flowSig>.xml`: intermediate analysis, resume state, current chain, and next hop; set `metadata.kind = handoff`
- `r_<sourceId>_<sinkId>_<flowSig>.xml`: finalized result, report input, and PoC handoff record; set `metadata.kind = result`
- `report.md`: final Markdown report generated through `decx-report`

Templates:

- `assets/decx-analysis-template.xml`

Use `decx-analysis-template.xml` as the only XML analysis and handoff template. Do not use older analysis or handoff templates.

File naming rules:

- `sourceId` identifies the analysis-chain source.
- `sinkId` identifies the current known or suspected sink.
- `flowSig` is the current analyzed class-level service, interface, manager, or method-owner signature; if one class contains multiple issues, keep them as multiple `result` entries in the same artifact.
- Create framework artifacts with `node skills/decx-framework-vulnhunt/assets/decx-artifact.mjs`.
- Do not create `decx-analysis.xml` or separate PoC handoff XML files.

Treat persisted artifacts as stale if they conflict with the current framework artifact, device build, or session target.

## State Model

| State | Meaning | Allowed |
|------|---------|---------|
| `candidate` | suspicious path found, still missing evidence | Yes |
| `statically-supported` | static evidence supports reachability, control, bypassability, and visible impact | Yes |
| `rejected` | unreachable, uncontrollable, blocked, or not impactful | Yes |

Every supported finding must include:

- reachable Binder/service entrypoint and attacker-controllable source
- `callChain`
- `guards`
- `bypass`
- `impact`
- `rating`
- `rationale`
- `evidence`

If impact cannot be mapped to `references/risk-rating.md`, do not promote it.

## Workflow

```text
Framework VulnHunt Progress
- [ ] Prepare framework target and confirm session
- [ ] Enumerate Binder / framework attack surface
- [ ] Build permission, UID, package, user, and identity context
- [ ] Route services to overview and pattern references
- [ ] Classify each target as candidate / statically-supported / rejected
- [ ] Trace per-service flows one method chain at a time
- [ ] Trace required cross-service or manager chains
- [ ] Filter by exploitability and rating gate
- [ ] Generate final report through decx-report
- [ ] Hand one PoC-ready finding to decx-poc
```

Use `references/framework-workflow.md` for phase commands, mandatory subagent dispatch, method labels, rejection checks, finding fields, resume rules, and PoC handoff details. Use `references/index.md`, `references/overviews/service.md`, and the smallest matching `references/patterns/*.md` cards for vulnerability recognition.

## Phase Summary

- Prepare: open the final framework bundle through `framework run`, `collect` -> `process` -> `open`, or a provided final JAR.
- Recon: enumerate Binder service name, AIDL interface, Stub implementation, manager facade, privileged sink families, and live service metadata when available.
- Context: record enforced permissions, app-ops, UID/package binding, user/profile checks, identity-clearing blocks, and caller-controlled parameters.
- Route: start with `references/overviews/service.md`, then load the smallest matching `references/patterns/*.md` cards.
- First pass: set every target to `candidate`, `statically-supported`, or `rejected`; every rejection needs explicit blocker evidence.
- Per-service analysis: materialize one `h_<sourceId>_<sinkId>_<flowSig>.xml` with `decx-artifact.mjs`, then delegate each tainted-data-relevant method chain to `decx-subagent-analysis`.
- Cross-service analysis: continue only for Binder boundaries, manager facades, identity/grant/user-selection state, permission delegation, async callbacks, or downstream reachability; use `nextHop` as the next subagent task.
- Exploitability filter: require reachability, controllability, guard bypassability, visible impact, impact evidence, and rating rationale.
- Report: hand finalized `r_<sourceId>_<sinkId>_<flowSig>.xml` artifacts to `decx-report`; this skill does not own report templates.

## Handoff To `decx-poc`

Pass only one `statically-supported` finding whose `pocReady` is true.

- Fill the XML `poc` block in the selected `result`; do not create a separate PoC handoff file.
- Keep one PoC-ready result per handoff unless explicitly asked for a batch handoff.
- Never pass large raw source blocks, unrelated inventory rows, unrelated services, or findings below `statically-supported`.

## References

- `references/index.md`
- `references/framework-workflow.md`
- `references/overviews/service.md`
- `references/risk-rating.md`
- `references/patterns/*.md`
- `references/casebooks/*.md`
