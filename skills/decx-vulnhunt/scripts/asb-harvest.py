#!/usr/bin/env python3
"""Harvest one Android Security Bulletin month into JSON plus a section summary.

The bulletin tables are rendered client-side, so a plain HTTP fetch returns the page
shell: 2026-01 carries a single vendor entry and 2026-02 carries none at all, while
2026-03 has 110 rows. This script drives headless Chrome, parses the rendered DOM with
the standard library only, and keeps every AOSP/vendor patch link it finds.

    python3 asb-harvest.py 2026-03-01                      # -> /tmp/asb-2026-03-01.json
    python3 asb-harvest.py 2026-03-01 --json out.json --print

Chrome is located through `--chrome`, then `$CHROME`, then the usual per-platform
locations; on a machine without Chrome the script exits 2 with a clear message.
"""
from __future__ import annotations

import argparse
import html as H
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

BULLETIN = "https://source.android.com/docs/security/bulletin/{year}/{month}?hl=en"
TAG = re.compile(r"<[^>]+>")
NOISE = {"", "build", "connect", "get help", "versions", "type", "severity",
         "abbreviation", "definition", "android and google service mitigations",
         "common questions and answers", "announcements"}


def find_chrome(explicit: str | None) -> str:
    candidates = [explicit, os.environ.get("CHROME"), os.environ.get("CHROME_PATH")]
    candidates += [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        shutil.which("google-chrome"), shutil.which("chromium"), shutil.which("chrome"),
        os.path.join(os.environ.get("PROGRAMFILES", ""), "Google", "Chrome", "Application", "chrome.exe"),
        os.path.join(os.environ.get("LOCALAPPDATA", ""), "Google", "Chrome", "Application", "chrome.exe"),
    ]
    for candidate in candidates:
        if candidate and Path(candidate).exists():
            return candidate
    raise SystemExit("no Chrome found: pass --chrome <path> or set $CHROME")


def render(chrome: str, url: str, budget_ms: int) -> str:
    return subprocess.run(
        [chrome, "--headless=new", "--disable-gpu", "--no-sandbox", "--dump-dom",
         f"--virtual-time-budget={budget_ms}", url],
        capture_output=True, text=True, check=False).stdout


def text_of(fragment: str) -> str:
    return re.sub(r"\s+", " ", H.unescape(TAG.sub(" ", fragment))).strip()


def iter_tables(page: str):
    heads = [(m.start(), text_of(m.group(0)))
             for m in re.finditer(r"<h[23][^>]*>.*?</h[23]>", page, re.S)]
    for table in re.finditer(r"<table\b.*?</table>", page, re.S):
        heading = ""
        for position, title in heads:
            if position < table.start():
                heading = title
        if heading.lower() in NOISE:
            continue
        rows = []
        for row in re.finditer(r"<tr\b.*?</tr>", table.group(0), re.S):
            cells = [cell.group(0) for cell in re.finditer(r"<t[dh]\b.*?</t[dh]>", row.group(0), re.S)]
            rows.append(([text_of(cell) for cell in cells],
                         [url for cell in cells for url in re.findall(r'href="([^"]+)"', cell)]))
        if rows:
            yield heading, rows


def parse(page: str) -> list[dict]:
    article = re.search(r"<article\b.*?</article>", page, re.S)
    body = article.group(0) if article else page
    records: list[dict] = []
    for heading, rows in iter_tables(body):
        header = [cell.lower() for cell in rows[0][0]]
        if not any("cve" in cell for cell in header):
            continue
        for cells, references in rows[1:]:
            if not cells or not cells[0].startswith("CVE-"):
                continue
            record: dict = {"section": heading, "cve": cells[0], "references": references}
            for column, value in zip(header, cells):
                if "severity" in column:
                    record["severity"] = value
                elif "subcomponent" in column:
                    record["subcomponent"] = value
                elif column == "type":
                    record["type"] = value
                elif "aosp" in column or "version" in column:
                    record["versions"] = value
            if "severity" not in record and len(cells) >= 4:
                record["severity"] = cells[2] or cells[3]
                record["subcomponent"] = cells[-1]
            records.append(record)
    return records


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("month", help="bulletin month, e.g. 2026-03-01")
    parser.add_argument("--json", dest="out", default=None, help="output path (default /tmp/asb-<month>.json)")
    parser.add_argument("--chrome", default=None, help="chrome executable")
    parser.add_argument("--budget-ms", type=int, default=15000, help="virtual time budget")
    parser.add_argument("--print", dest="show", action="store_true", help="print every record")
    args = parser.parse_args()

    url = BULLETIN.format(year=args.month[:4], month=args.month)
    records = parse(render(find_chrome(args.chrome), url, args.budget_ms))
    out = Path(args.out or f"/tmp/asb-{args.month}.json")
    out.write_text(json.dumps({"month": args.month, "url": url, "records": records}, indent=1))
    sections: dict[str, int] = {}
    for record in records:
        sections[record["section"]] = sections.get(record["section"], 0) + 1
    print(f"{args.month}: {len(records)} rows -> {out}")
    for section, count in sorted(sections.items(), key=lambda item: (-item[1], item[0])):
        print(f"  {count:3d}  {section}")
    if args.show:
        for record in records:
            print(json.dumps(record, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
