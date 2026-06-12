---
name: decx-report
description: Generate DECX vulnerability reports from SQLite blackboard finalized findings. Use after decx-app-vulnhunt or decx-framework-vulnhunt has produced finding records; prefer HTML reports and optionally emit Markdown.
metadata:
  requires:
    bins: ["decx"]
---

# DECX - Report Generation

Use this skill only for report writing from existing finalized finding records in the SQLite blackboard.

## Routing Gate

Use only when the user asks for a report from existing DECX finalized findings or residual candidate summaries produced by either `decx-app-vulnhunt` (app targets) or `decx-framework-vulnhunt` (framework targets). Query the blackboard with `node scripts/decx-analysis-db.mjs`. Do not use for vulnerability discovery, chain tracing, PoC construction, DECX command help, or generic security-report templates. If no finalized findings exist, route back to the relevant vulnhunt skill (`decx-app-vulnhunt` for APK targets, `decx-framework-vulnhunt` for framework/Binder targets).

## Rules

- Report only chains proven statically-supported via graph traversal:
  ```bash
  node scripts/decx-analysis-db.mjs path <dir> --from <entrypoint_fact> --to <sink_fact>
  node scripts/decx-analysis-db.mjs export <dir>
  ```
- Keep unresolved intents in a residual section; never turn them into confirmed issues:
  ```bash
  node scripts/decx-analysis-db.mjs intents <dir> --status open
  ```
- Exclude rejected targets from issue sections unless the user explicitly asks for a coverage appendix.
- Never write `verified`, `runtime-validated`, `poc-validated`, or equivalent unless the finding record explicitly contains that state.
- Do not invent missing guards, call-chain nodes, impact, or bypass conditions.
- Default report language is Chinese (`zh`). Generate English (`en`) or bilingual (`both`) only when the user explicitly requests it.
- Prefer HTML output. Generate Markdown only when the user asks for it, the environment cannot write HTML, or a downstream tool requires Markdown.
- Re-fetch only the minimal source locations needed to quote evidence:

```bash
decx code method-source "<method>" -P <port>
```

## Inputs

- Required: chain data from `node scripts/decx-analysis-db.mjs export <dir>`. Determine the target kind from fact descriptions: if any fact starts with `service-entrypoint:` or `binder-reachability:`, the target is framework; otherwise app. Fact prefixes and chain-origin rules differ by kind (see Report Semantics).
- Optional: residual intents from `intents <dir> --status open`, exported session via `--session <name>`, language `zh|en|both`, and output path.

## Output Modes

- Full report: all finalized findings plus residual candidates.
- Single-finding report: exactly one `findingId`; exclude unrelated inventory.
- Templates: `assets/report-template-html.html`, optional `assets/report-template-zh.md`, `assets/report-template-en.md`.

## Report Semantics

- `Full Call Chain` starts from the victim entrypoint or Binder-exposed method, depending on the target kind (inferred from fact prefixes).
- For app targets (facts with `entrypoint:` prefix): start from the exported component callback (Activity `onCreate`/`onNewIntent`, Receiver `onReceive`, Provider `query`/`insert`/`update`/`delete`/`call`, Service `onBind`/`onStartCommand`). Do not start with `AttackerApp.*`, `bindService`, `startActivity`, `sendBroadcast`, `ContentResolver.*`, adb steps, or PoC driver actions.
- For framework targets (facts with `service-entrypoint:` or `binder-reachability:` prefix): start from Binder service / Stub / manager facade entry point and continue through to the privileged sink. Include identity and authorization state at the Binder trust boundary (`identity:` and `permission-guard:` / `appop-guard:` / `user-guard:` facts).
- Attacker actions belong only in `Attack Path`.
- Every finding renders as **four top-level sections** at the same visual weight (each its own `<section>` with `h2`):
  1. **目标情况** — one-line component/interface context plus `meta-row` with component/permission/process.
  2. **问题说明** — vulnerability description plus a 4-step call-chain card (入口 → 可控 → 保护 → Sink) with inline edge labels, ending with one consolidated `pre` evidence block.
  3. **组合链利用** — same-level `h2` that branches by composition status (see branch rules below).
  4. **安全建议与修复** — remediation in a blue `.fix` callout.

- **组合链利用** must analyze **cross-finding composition** — how this finding combines with OTHER findings (F1-Fn) to amplify impact. This section has the same visual weight as 问题说明 (same-level `<section>` with `<h2>`), and must contain all four of the following blocks:
  1. **组合分析** — prose describing which other findings compose with this one, the amplification effect of each combination, and whether the combination is redundant with this finding's standalone path. For each composition pair, state the edge type (`enable` / `carry` / `amplify` / `bypass`) and why the combination is realistic (compatible attacker positions, transferred objects).
  2. **效果比较表** — a table comparing standalone vs composed paths: columns = [路径, 攻击步骤数, 是否需要暴破, 最终获取]. This lets the reader see at a glance which compositions change the attack surface.
  3. **完整攻击路径** — numbered attack steps covering the full composed chain (not just this finding's internal path). Include all findings in the chain, with their F-numbers as references.
  4. **真实影响** — what the attacker gains after composition, compared to standalone impact. State explicitly what changes: does composition reduce attack cost, eliminate a step, expand scope, or enable a new attacker position?
- When a finding **cannot compose** with any other finding (truly isolated), show a single `dead-end` notice with the reason. Do not label findings as "单点" and skip composition analysis — instead, explain which compositions were evaluated and why they are redundant or do not improve impact.
- Every finding must also contain a **自身攻击路径** (the standalone internal path from 问题说明), so readers can compare standalone vs composed.

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

## Gotchas

Concrete failure modes from real report runs. These produce reports that look complete but fail downstream review or violate the artifact contract.

- **Upgrading state without finding record backing**: writing `verified`, `runtime-validated`, `poc-validated`, or equivalent in the report because a PoC "worked" silently elevates the finding above what the record proves. The report must mirror the DB state; promotion is the vulnhunt skill's job, not the report skill's.
- **Starting `Full Call Chain` with attacker actions**: for app IPC, the chain must start at the victim entrypoint (exported component callback, broadcast receiver, provider method). Starting from `AttackerApp.*`, `bindService`, `startActivity`, `sendBroadcast`, `ContentResolver.*`, adb commands, or PoC driver actions breaks the chain-origin contract and is rejected on review. Attacker actions belong only in `Attack Path`.
- **Promoting `candidate` entries into the issue list**: `candidate` results stay in the residual section. They are not confirmed issues, regardless of how complete the trace looks.
- **Defaulting to Markdown**: Markdown is the fallback only when HTML is unavailable or the caller requires it. Default is HTML. Generating `report.md` by default violates the Output Contract and is rejected on review.
- **Defaulting to English**: the default language is Chinese (`zh`). Generating English or bilingual reports when the user did not request them breaks the language contract.
- **Fabricating guard evidence from memory**: when the record has unresolved guard branches, do not infer the branch outcome from training data. Re-query `decx code method-source` on the exact signature, prove the branch, and update the record before writing the report.
- **Pulling entire DB dump into the report**: the report cites minimal source locations only. Embedding the full decompiled class, the full chain dump, or the full candidate pool burns context and leaks internal artifact structure into the deliverable.
- **Cross-referencing findings across languages without re-anchoring**: anchors (`findingId` / `sourceId-sinkId-flowSig`) must match between HTML and Markdown. Regenerating one without regenerating the other produces broken anchors in the Markdown variant.
- **Reintroducing excluded status**: rejected targets stay out of issue sections unless the user explicitly asks for a coverage appendix. Never silently fold them into the residual list.
- **Starting framework `Full Call Chain` from the client app**: for framework targets (facts with `service-entrypoint:` prefix), the chain must start from the Binder service / Stub / manager facade entry point in the framework code, not from the attacker app's `ServiceManager.getService()` call. Starting from the client side violates the chain-origin contract.
- **Omitting identity/authorization evidence for framework findings**: framework findings require identity (`identity:`) and guard (`permission-guard:` / `appop-guard:` / `user-guard:` / `identity-transition:`) facts at the Binder trust boundary. Reporting a framework finding without this evidence produces a chain that looks complete but lacks the authorization proof the vulnhunt skill required for promotion.
- **Mixing app and framework chain-origin rules**: app targets start the chain at the exported component callback; framework targets start at the Binder/Stub/manager facade entry. Using the wrong rule for the target kind produces a chain that fails review. Infer kind from fact prefixes: `entrypoint:` → app; `service-entrypoint:` → framework.

## References

- `assets/report-template-html.html`
- `assets/report-template-zh.md` (optional)
- `assets/report-template-en.md` (optional)
