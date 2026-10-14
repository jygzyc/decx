# Portable execution skills

`.agents/skills/` is the canonical, versioned source of DECX's portable execution
skills. Compatible agents can discover them directly; `npx skills` owns their
installation, updates and removal in other projects. Skills are sourced from the
repository independently of CLI releases, never bundled into npm or Release assets.
The npm CLI is the unified entry for installing, locating and running analysis
tools. It does not manage skills or install agent plugins.

- Keep `SKILL.md` self-contained, with an accurate routing gate, negative
  constraints and references relative to its own directory. Execution must not
  require a repository checkout, maintenance service or agent-specific extension.
- `decx-tool` owns tool routing; each tool's native command and output contract
  belongs in `references/<tool>.md`. Invoke tools through `decx <tool>` or
  `decx -m <tool>` without translating their arguments or output.
- Kuna's reference is copied from its pinned upstream skill verbatim apart from
  frontmatter. Re-copy it when the pin moves; never edit it locally.
- Keep only execution resources here. Do not add maintenance metadata or import
  private analysis data from ignored local archives.
- Validate with `python3 scripts/check-skills.py` and
  `python3 -m unittest discover -s scripts -p 'test_check_skills.py'`.
