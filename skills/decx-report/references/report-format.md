# Report Format

## Default Outputs

- `report.html`
- `report.zh.md`
- `report.en.md`

Language: `report.html` uses a Chinese UI, `report.zh.md` is Chinese, `report.en.md` is English.

Each output must contain the same finding IDs and the same issue model.

## Finding Sections

Each finding has four sections:

1. Target context
2. Issue explanation
3. Composition analysis
4. Remediation

## Composition Section

For each finding, state one of:

- composed: name the related findings and the composition that links them;
- not composed: name the checked relation and the blocker.

Do not omit composition analysis. Do not invent composition when no evidence supports it.
There is no `unknown` or partial verdict: exactly `composed` or `not composed`.

## Rating Fields

- `rating` and its rationale come from `decx-vulnhunt` `references/risk-rating.md`; copy
  them, never recompute or average across findings, and never assert `runtime-validated`
  or `poc-validated`.
- `riskClass` is derived from `rating`: the stylesheet knows exactly `critical`, `high`,
  `medium` and `low`, while the badge text stays the raw `{{issue.rating}}`. No template
  has an `unknown` / `TBD` rating path.

## Template Structure

- The HTML issue card `<section class="issue risk-{{issue.riskClass}}" id="{{issue.anchor}}">`
  contains section 1 only; sections 2–4 are sibling `<section>` elements after the card
  closes, and `{{issue.anchor}}` sits on the card.
- Never reorder or rename sections, drop a table column, or mint an id/anchor that is not
  the writeup `id`: all formats share the finding ids and the evidence model.
- Summary columns are fixed per format: HTML `# | 风险 | 问题 | 组件 | 组合链` (linking
  `{{issue.anchor}}`), `report.zh.md` `ID | 风险 | 标题 | 入口 | 影响`, and
  `report.en.md` `ID | Risk | Title | Entry | Impact`.
- The HTML chain block binds the four step kinds to fixed positions (`entry`, `control`,
  `guard`, `sink`, badges 入口 / 可控 / 保护 / Sink) with an edge label between each pair,
  and the comparison table is fixed to `路径 | 攻击步骤数 | 是否需要暴破 | 最终获取`.
- Load each template only at render time: intake and issue-model building never need them.
