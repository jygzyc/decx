---
name: decx-report
description: Generate DECX vulnerability reports from finalized r_sourceId_sinkId_flowSig XML artifacts. Use after decx-app-vulnhunt or decx-framework-vulnhunt has produced XML result artifacts; prefer HTML reports and optionally emit Markdown.
metadata:
  requires:
    bins: ["decx"]
---

# DECX - Report Generation

Use this skill only for report writing from existing finalized result XML artifacts.

## Routing Gate

Use only when the user asks for a report from existing DECX `r_*.xml` result artifacts or residual candidate summaries from matching handoff XML. Do not use for vulnerability discovery, chain tracing, PoC construction, DECX command help, or generic security-report templates. If no finalized result XML is available, route back to the relevant vulnhunt skill.

## Rules

- Report only XML `result` entries with `status = statically-supported`.
- Keep `candidate` targets in a residual section; never turn them into confirmed issues.
- Exclude rejected targets from issue sections unless the user explicitly asks for a coverage appendix.
- Never write `verified`, `runtime-validated`, `poc-validated`, or equivalent unless the XML explicitly contains that state.
- Do not invent missing guards, call-chain nodes, impact, or bypass conditions.
- Default report language is Chinese (`zh`). Generate English (`en`) or bilingual (`both`) only when the user explicitly requests it.
- Prefer HTML output. Generate Markdown only when the user asks for it, the environment cannot write HTML, or a downstream tool requires Markdown.
- Re-fetch only the minimal source locations needed to quote evidence:

```bash
decx code method-source "<method>" -P <port>
```

## Inputs

- Required: one or more `.decx-analysis/<target>/r_*.xml` files with `metadata.kind = result`.
- Optional: matching `h_<sessionName>.xml` for residual candidates, `findingId`, language `zh|en|both`, and output path.

## Output Modes

- Full report: all supported XML `result` entries plus residual candidates only from matching handoff artifacts.
- Single-finding report: exactly one `findingId`; exclude unrelated inventory.
- Templates: `assets/report-template-html.html`, optional `assets/report-template-zh.md`, `assets/report-template-en.md`.

## Report Semantics

- `Full Call Chain` starts from the victim entrypoint or Binder-exposed method.
- Attacker actions belong only in `Attack Path`.
- For app IPC, do not start `Full Call Chain` with `AttackerApp.*`, `bindService`, `startActivity`, `sendBroadcast`, `ContentResolver.*`, adb steps, or PoC driver actions.
- For framework Binder findings, start from Binder service / Stub / manager facade entry and continue to the privileged sink.
- Every issue must include background, full call chain, numbered code evidence, bypass/uncertainty, attack path, visible impact, rating rationale, and remediation.

## Output Contract

Default output:

- `report.html`
- standalone HTML with inline CSS
- no remote scripts, fonts, images, or analytics
- issue anchors based on `findingId` or `sourceId-sinkId-flowSig`
- residual candidates kept in a separate section

Optional output:

- `report.md` only when requested or required by the caller
- keep Markdown content semantically identical to the HTML report
