#!/usr/bin/env python3
"""Validate the skills: one SKILL.md per skill, YAML frontmatter with a name that
matches its directory, a usable description, and relative links that resolve
inside the repository.  Every skill lives in its own directory under `skills/`.

Usage: python3 skills/check-skills.py [skills-root ...]
       (default: skills/)
Exit status is non-zero when any problem is found.
"""

import pathlib
import re
import sys

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent


def default_roots() -> list[pathlib.Path]:
    return [REPO_ROOT / "skills"]


def scalar_syntax_problem(field: str, raw: str):
    """Catch the YAML plain-scalar cases the lightweight parser below misses."""
    value = raw.strip()
    if value.startswith(("\"", "'")):
        if len(value) < 2 or not value.endswith(value[0]):
            return f"{field} has an unterminated quoted scalar"
        return None
    if re.search(r":\s", value):
        return f"{field} contains ': '; quote the scalar"
    if re.search(r"\s#", value):
        return f"{field} contains an unquoted YAML comment marker"
    return None


def main() -> int:
    args = sys.argv[1:]
    if args:
        roots = [pathlib.Path(arg).resolve() for arg in args]
        for root in roots:
            if not root.is_dir():
                print(f"no skills directory at {root}", file=sys.stderr)
                return 1
    else:
        roots = default_roots()
    skills = sorted(p for root in roots if root.is_dir() for p in root.iterdir() if p.is_dir())
    if not skills:
        print(f"no skills found under {', '.join(str(root) for root in roots)}", file=sys.stderr)
        return 1

    problems: list[str] = []
    seen: dict[str, list[str]] = {}
    for skill in skills:
        md = skill / "SKILL.md"
        if not md.is_file():
            problems.append(f"{skill.name}: missing SKILL.md")
            continue
        text = md.read_text(encoding="utf-8")
        m = re.match(r"^---\n(.*?)\n---\n", text, re.S)
        if not m:
            problems.append(f"{skill.name}: SKILL.md has no YAML frontmatter")
            continue
        fm = m.group(1)
        name = re.search(r"^name:\s*(.+)$", fm, re.M)
        desc = re.search(r"^description:\s*(.+)$", fm, re.M)
        if not name or not name.group(1).strip():
            problems.append(f"{skill.name}: frontmatter has no name")
        elif name.group(1).strip() != skill.name:
            problems.append(
                f"{skill.name}: frontmatter name '{name.group(1).strip()}' != directory name"
            )
        if not desc or len(desc.group(1).strip()) < 20:
            problems.append(f"{skill.name}: frontmatter description missing or too short")
        else:
            syntax = scalar_syntax_problem("description", desc.group(1))
            if syntax is not None:
                problems.append(f"{skill.name}: {syntax}")
        if name:
            seen.setdefault(name.group(1).strip(), []).append(skill.name)
        for link in re.findall(r"\]\(([^)\s]+)\)", text):
            if link.startswith(("http://", "https://", "#", "mailto:")):
                continue
            target = (skill / link.split("#", 1)[0]).resolve()
            if not target.exists():
                problems.append(f"{skill.name}: link does not resolve: {link}")

    for name, dirs in seen.items():
        if len(dirs) > 1:
            problems.append(f"duplicate skill name {name}: {dirs}")

    for problem in problems:
        print(f"::error::{problem}")
    print(f"checked {len(skills)} skills, {len(problems)} problem(s)")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
