---
name: decx-report
description: Generate DECX vulnerability reports from finalized r-sourceId-sinkId-flowSig XML artifacts. Use after decx-app-vulnhunt or decx-framework-vulnhunt has produced XML coverage, findings, and vulnerability judgement; supports full reports and single-finding reports.
metadata:
  requires:
    bins: ["decx"]
---

# DECX CLI - Report Generation

Use this skill only for report writing from existing finalized result XML artifacts.

Scope:

- In scope: full Markdown reports, single-finding Markdown reports, residual candidate summaries
- Out of scope: new vulnerability analysis, PoC construction, runtime confirmation
- Source of truth: finalized `r_*.xml` with `metadata.kind = result`
- Template index: `assets/report-template.md`

## Rules

- Report only XML `result` entries with `status = statically-supported`.
- Keep `candidate` targets in a residual section; never turn them into confirmed issues.
- Exclude rejected targets from issue sections unless the user explicitly asks for a coverage appendix.
- Never write `verified`, `runtime-validated`, `poc-validated`, or equivalent unless the XML explicitly contains that state.
- Do not invent missing guards, call-chain nodes, impact, or bypass conditions.
- Re-fetch only the minimal source locations needed to quote evidence:

```bash
decx code method-source "<method>" -P <port>
```

## Inputs

Required:

- one or more `.decx-analysis/<target>/r_*.xml` files with `metadata.kind = result`

Optional:

- matching `h_*.xml` files for residual candidate or coverage context; multiple h-files may share one `sourceId` when the chain crosses classes/components or sinks
- `findingId` for a single-finding report
- language: `zh`, `en`, or `both`
- report path, default `report.md`

## Output Modes

Full report:

- Use all supported XML `result` entries.
- Include coverage from XML source/sink ids, `flowSig` or component signature, `analyzedChains`, and `result` entries.
- Include residual candidates only when matching handoff artifacts are provided.

Single-finding report:

- Use exactly one finding selected by `findingId`
- Include only the target context and residual uncertainty relevant to that finding
- Do not include unrelated inventory rows

## Template Selection

- `zh`: `assets/report-template-zh.md`
- `en`: `assets/report-template-en.md`
- `both`: Chinese first, then English

## Report Semantics

- `Full Call Chain` starts from the victim entrypoint or Binder-exposed method.
- Attacker actions belong only in `Attack Path`.
- For app IPC, do not start `Full Call Chain` with `AttackerApp.*`, `bindService`, `startActivity`, `sendBroadcast`, `ContentResolver.*`, adb steps, or PoC driver actions.
- For framework Binder findings, start from Binder service / Stub / manager facade entry and continue to the privileged sink.
- Every issue must include:
  - background
  - full call chain
  - numbered code evidence
  - bypass conditions or uncertainty
  - attack path
  - visible impact
  - rating rationale
  - remediation
