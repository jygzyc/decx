# DECX v3.3.0

DECX v3.3.0 restructures and unifies the skill system: renames skills to follow consistent naming, simplifies reference architecture by consolidating casebooks and overviews into a single `patterns/` tree per skill, eliminates cross-skill redundancy, and standardizes pattern documentation.

### Changes

- Skills: renamed `decxcli` to `decx-cli`, `decxcli-app-vulnhunt` to `decx-app-vulnhunt`, `decxcli-framework-vulnhunt` to `decx-framework-vulnhunt`, `decxcli-poc` to `decx-poc`.
- Skills: renamed `decx-subagent-analysis` to `decx-subagent`.
- Skills: unified `flowSig` definition across all skills — "current analyzed component signature for the analysis chain".
- Skills: unified banned-claim lists across `decx-app-vulnhunt` and `decx-framework-vulnhunt`.
- Skills: established single-source-of-truth principles — chain pivots only in `index.md`, rating authority in `risk-rating.md`, false-positive rules in SKILL.md + `index.md`.
- Skills: removed the `casebooks/` and `overviews/` reference trees from `decx-app-vulnhunt` and `decx-framework-vulnhunt`; surviving knowledge is folded into a leaner `patterns/` set.
- Skills: consolidated to 25 unified pattern files (15 app + 10 framework) with topic-style names — consistent headings, bold Sources/Sinks, combined Guards & Rejection, Example Shapes, and report guidance.
- Skills: added new patterns `archive-extraction`, `cross-app-channels` (app) and `native-surface`, `validation-gap` (framework).
- Skills: added `skills/AGENTS.md` documenting skill authoring rules and reference architecture.
- Added `decx/decx/AGENTS.md` documenting Kotlin module architecture and coding conventions.
- Updated root `AGENTS.md` — fixed path typo, added `skills/AGENTS.md` cross-reference.
- Updated `hooks/session-start` with correct skill name references.
