# Agent skill source

`skills/` at the repository root is the installable source of portable execution
skills. The pi release bundle copies these skills unchanged to its `skills/`
folder for portable releases; `/decx init` creates an empty `.agents/skills/`
layer, while `npx skills` installs skills from this root directory. They also
work in Agent Skills-compatible harnesses without the pi extension.

- Keep `SKILL.md` self-contained, with an accurate routing gate, negative
  constraints, and references relative to its own directory. Never require the
  repository checkout or the maintenance wiki during inference.
- `decx-tool` owns tool routing; each native tool's command and output contract
  belongs in `references/<tool>.md`. Kuna's reference is copied from its pinned
  upstream skill verbatim apart from frontmatter; re-copy it, never edit it.
- WikiSkill maintenance is implemented in `.pi/extensions/decx/`; do not create
  a separate wiki skill or copy archived knowledge into this directory. The old
  knowledge is local-only under ignored `archive/legacy-knowledge/`.
- Validate with `python3 skills/check-skills.py` and the extension tests.
