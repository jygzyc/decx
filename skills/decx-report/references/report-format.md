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
