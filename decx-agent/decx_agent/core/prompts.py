from __future__ import annotations

from ..decx.client import allowed_probe_names
from .board import Intent, Project
from .skills import SkillBundle


RULES = """\
Rules:
- You are a DECX worker, not the workflow owner.
- Use the referenced DECX skill files and the capability packet.
- Ask for DECX core observations with `probes`; the dispatcher executes them.
- Prefer evidence-backed facts over broad narrative.
- Do not run `decx` CLI commands, close sessions, or restart the DECX server.
- Return exactly one JSON object.
"""


def graph_text(project: Project) -> str:
    facts = "\n".join(f"- {fact.id}: {fact.description}" for fact in project.facts)
    intents = "\n".join(
        f"- {intent.id}: from={intent.from_ids} to={intent.to or '-'} worker={intent.worker or '-'} {intent.description}"
        for intent in project.intents
    )
    hints = "\n".join(f"- {hint.id}: {hint.content}" for hint in project.hints) or "- none"
    return f"Facts:\n{facts}\n\nIntents:\n{intents or '- none'}\n\nHints:\n{hints}"


def capability_packet(project: Project, skills: SkillBundle) -> str:
    probe_names = ", ".join(allowed_probe_names())
    return "\n".join([
        f"Active skill: {skills.active.name}",
        f"Target: {project.target}",
        f"Mode: {project.mode}",
        f"DECX port: {project.port or 'unset'}",
        "DECX core access: request dispatcher probes instead of shelling out.",
        f"Allowed probes: {probe_names}",
        "Probe shape: {\"name\":\"get_class_source\",\"payload\":{\"cls\":\"com.example.Foo\",\"filter\":{\"limit\":80}}}",
    ])


def skill_reference_text(skills: SkillBundle) -> str:
    return "\n".join(f"- {ref.label(skills.root)}" for ref in skills.references())


def bootstrap_prompt(project: Project, skills: SkillBundle) -> str:
    return f"""\
{RULES}

Task: bootstrap the DECX analysis.

Reference files:
{skill_reference_text(skills)}

Capability packet:
{capability_packet(project, skills)}

Current graph:
{graph_text(project)}

Return JSON:
{{
  "accepted": true,
  "data": {{
    "fact": {{"description": "one evidence-backed initial DECX fact"}},
    "probes": [
      {{"name": "get_app_manifest", "payload": {{}}}}
    ],
    "intents": [
      {{"description": "one narrow next exploration direction"}}
    ]
  }}
}}
"""


def explore_prompt(project: Project, intent: Intent, skills: SkillBundle) -> str:
    return f"""\
{RULES}

Task: explore one intent and produce one fact.

Reference files:
{skill_reference_text(skills)}

Capability packet:
{capability_packet(project, skills)}

Current graph:
{graph_text(project)}

Current intent:
- id: {intent.id}
- description: {intent.description}

Return JSON:
{{
  "accepted": true,
  "data": {{
    "fact": {{"description": "one concrete finding, rejection, guard, sink, or next-hop fact"}},
    "probes": [
      {{"name": "search_global_key", "payload": {{"key": "permission", "search": {{"limit": 20, "includes": [], "excludes": [], "caseSensitive": false, "regex": true}}}}}}
    ]
  }}
}}
"""


def reason_prompt(project: Project, skills: SkillBundle) -> str:
    return f"""\
{RULES}

Task: reason over the full graph.

Reference files:
{skill_reference_text(skills)}

Capability packet:
{capability_packet(project, skills)}

Current graph:
{graph_text(project)}

Return JSON. If the goal is satisfied:
{{
  "accepted": true,
  "data": {{"complete": {{"description": "why these facts satisfy the goal"}}}}
}}

If more work is needed:
{{
  "accepted": true,
  "data": {{
    "intents": [
      {{"description": "one narrow high-value DECX exploration direction"}}
    ]
  }}
}}
"""
