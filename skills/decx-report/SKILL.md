---
name: decx-report
description: Generate DECX vulnerability reports from proof-graph finalized findings. Use after decx-app-vulnhunt or decx-framework-vulnhunt has produced finding records; prefer HTML reports and optionally emit Markdown.
metadata:
  requires:
    bins: ["decx"]
---

# DECX - Report Generation

Use this skill only for report writing from existing finalized finding records in the evidence graph.

## Routing Gate

Use only when the user asks for a report from existing DECX finalized findings or residual candidate summaries. Query the evidence graph with `node scripts/decx-analysis-db.mjs`. Do not use for vulnerability discovery, chain tracing, PoC construction, or generic security-report templates. If no finalized findings exist, route back to the relevant vulnhunt skill.

## Input: Read Findings from Proof Graph

```bash
# All complete evidence chains
node scripts/decx-analysis-db.mjs chains <dir> --root-prefix entrypoint --leaf-prefix impact

# Single chain detail
node scripts/decx-analysis-db.mjs path <dir> --from <entrypoint_fact> --to <sink_fact>
node scripts/decx-analysis-db.mjs ancestors <dir> --fact <sink_fact>

# Full graph export
node scripts/decx-analysis-db.mjs export <dir>

# Unresolved intents (residual section)
node scripts/decx-analysis-db.mjs intents <dir> --status open

# Re-fetch minimal source for evidence quotes
decx code method-source "<method>" -P <port>
```

Determine target kind from fact prefixes: `service-entrypoint` or `binder-reachability` → framework; otherwise app.

## Rules

| Rule | Rationale |
|---|---|
| Report only chains proven via `path` or `chains` queries | unproven chains are not findings |
| Keep unresolved intents in residual section | open intents are not confirmed issues |
| Never write `verified` / `runtime-validated` / `poc-validated` | report mirrors DB state; promotion is vulnhunt's job |
| Do not invent missing guards, call-chain nodes, impact, or bypass conditions | fabricated evidence fails review |
| Default language: Chinese (`zh`); English/bilingual only when explicitly requested | language contract |
| Prefer HTML output; Markdown only when requested or environment requires it | output contract |
| Minimal source citations only; no full DB dumps | context + artifact hygiene |
| Anchors (`findingId` / `sourceId-sinkId-flowSig`) must match between HTML and Markdown | cross-format integrity |

## Report Semantics

**Chain origin by target kind:**
- App (`entrypoint` prefix): start from exported component callback (Activity `onCreate`/`onNewIntent`, Receiver `onReceive`, Provider `query`/`insert`/`update`/`delete`/`call`, Service `onBind`/`onStartCommand`). NOT from `AttackerApp.*`, `bindService`, `startActivity`, `sendBroadcast`, `ContentResolver.*`, adb, or PoC driver.
- Framework (`service-entrypoint`/`binder-reachability` prefix): start from Binder service / Stub / manager facade entry. Include identity + authorization at trust boundary (`identity` + `permission-guard`/`appop-guard`/`user-guard`).
- Attacker actions belong only in `Attack Path`.

**Four sections per finding (equal visual weight, each `<section>` with `<h2>`):**
1. **目标情况** — one-line context + `meta-row` (component/permission/process)
2. **问题说明** — vulnerability description + 4-step call-chain card (入口 → 可控 → 保护 → Sink) with inline edge labels + consolidated `pre` evidence
3. **组合链利用** — cross-finding composition analysis (see below)
4. **安全建议与修复** — remediation in `.fix` callout

**组合链利用 must contain:**
1. **组合分析** — which findings compose, edge type (`enable`/`carry`/`amplify`/`bypass`), why realistic
2. **效果比较表** — [路径, 攻击步骤数, 是否需要暴破, 最终获取]
3. **完整攻击路径** — full composed chain steps with F-number references
4. **真实影响** — what changes after composition vs standalone

When a finding **cannot compose**: show `dead-end` notice with reason. Do not skip composition analysis — explain which compositions were evaluated and rejected.

## Output Contract

Default: `report.html` — standalone HTML with inline CSS, no remote resources, residual candidates in separate section.

Optional: `report.md` only when requested. Content semantically identical to HTML.

Templates: `assets/report-template-html.html`, optional `assets/report-template-zh.md`, `assets/report-template-en.md`.

## Gotchas

- **Starting chain with attacker actions**: chain starts at victim entrypoint, not `AttackerApp.*` or PoC driver
- **Promoting candidates**: candidate results stay in residual section
- **Fabricating guard evidence**: re-query `decx code method-source` on exact signature, do not infer from training data
- **Mixing chain-origin rules**: app starts at component callback; framework starts at Binder/Stub facade
- **Omitting framework identity evidence**: framework findings need `identity` + guard facts at trust boundary

## References

- `assets/report-template-html.html`
- `assets/report-template-zh.md` (optional)
- `assets/report-template-en.md` (optional)
