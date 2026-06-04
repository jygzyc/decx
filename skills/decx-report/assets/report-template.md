# Report Template Index

This skill provides one preferred HTML template and two optional Markdown templates:

- Preferred HTML: `assets/report-template-html.html`
- Optional Chinese Markdown: `assets/report-template-zh.md`
- Optional English Markdown: `assets/report-template-en.md`

Default behavior:

1. generate `report.html` from `assets/report-template-html.html`
2. render Chinese, English, or bilingual content inside the HTML body according to the requested language
3. generate Markdown only when explicitly requested or required by a downstream tool

If the task asks for bilingual Markdown output, generate:

1. a Chinese report using `assets/report-template-zh.md`
2. an English report using `assets/report-template-en.md`

For a single-finding report, keep the same issue structure but include only the selected `findingId`.
