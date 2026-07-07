# Installing DECX for OpenCode

## Prerequisites

- [OpenCode.ai](https://opencode.ai) installed

## Installation

Add DECX to the `plugin` array in your `opencode.json`:

```json
{
  "plugin": ["decx@git+https://github.com/jygzyc/decx.git"]
}
```

Restart OpenCode. The plugin is the DECX workflow entrypoint. It does not register external prompt paths.


## Session Isolation

By default, each main OpenCode session writes to its own database and task directory:

```text
.decx-analysis/<main-session-id>/decx-analysis.db
.decx/opencode-plugin/tasks/<main-session-id>/
```

Spawned Explorer/Evaluator/Metacog sessions inherit the parent graph directory. Different top-level analysis sessions do not share a database unless you explicitly pass the same `graphDir`. Cross-session analysis is available through read-only federation tools; it does not merge DBs or allow cross-DB writes.

## Available Tools

| Tool group | Functions |
|---|---|
| Planner/MainAgent | `decx_planner_init`, `decx_planner_add_root_fact`, `decx_planner_create_intent`, `decx_planner_add_human_hint`, `decx_planner_respond_hint`, `decx_planner_fail_intent`, `decx_planner_spawn_explorer`, `decx_planner_spawn_evaluator`, `decx_planner_stop_agent`, `decx_planner_start_metacog`, `decx_planner_restart_metacog` |
| Explorer | `decx_explorer_claim_intent`, `decx_explorer_renew_intent`, `decx_explorer_add_candidate`, `decx_explorer_conclude_intent` |
| Evaluator | `decx_evaluator_verdict` |
| Metacog | `decx_metacog_add_hint`, `decx_metacog_heartbeat` |
| Read-only current graph | `decx_graph_facts`, `decx_graph_intents`, `decx_graph_hints`, `decx_graph_agents`, `decx_graph_links`, `decx_graph_path`, `decx_graph_ancestors`, `decx_graph_descendants`, `decx_graph_chains`, `decx_graph_export`, `decx_graph_check` |
| Read-only cross graph | `decx_cross_graphs`, `decx_cross_export`, `decx_cross_search`, `decx_cross_compare_facts` |
| Session state | `decx_session_state` |
| Profile assets | `decx_knowledge`, `decx_profile_assets` |
| Role help | `decx_role` |

## Agents

Available DECX agents:

- `decx-planner` — explicit Planner/MainAgent.
- `decx-explorer` — planner-created single-intent worker.
- `decx-evaluator` — planner-created candidate fact reviewer.
- `decx-metacog` — single live 30s graph monitor.

## Role Capabilities

| Role | Capability boundary |
|---|---|
| Planner/MainAgent | Sole orchestrator. Creates intents and subagents, responds to hints, stops agents, and fails intents with accepted evidence. |
| Explorer | Planner-created subagent for one intent. Claims, executes, writes candidate facts, and concludes execution. Cannot fail intent. |
| Evaluator | Planner-created subagent for one candidate fact. Only accepts/rejects/demotes. |
| Metacog | Single live monitoring subagent. Reviews full graph every 30 seconds and writes correction hints. |
| System | Plugin hooks: context injection, env injection, timeline logging, bypass blocking, and metacog timer cleanup. |

Every subagent graph write must include its Planner-assigned agent ID in the `by` field. The graph engine rejects mismatched Explorer intent writes, mismatched Evaluator verdicts, and inactive Metacog hint writes.

Each analysis profile owns its own knowledge-base and scripts under `.opencode/plugins/profiles/<profile-id>/`. Topics are loaded on demand with `decx_knowledge(profile=..., topic=...)`, and profile paths are discoverable through `decx_profile_assets`. Role prompt injection lives in each profile `index.js`, while `.opencode/plugins/lib/base-plugin.js` keeps the reusable graph substrate unchanged.

## Typical Flow

```text
mainAgent: decx_planner_init
mainAgent: decx_planner_add_root_fact
mainAgent: decx_planner_create_intent
mainAgent: decx_planner_start_metacog
mainAgent: decx_planner_spawn_explorer
explorer:  decx_explorer_claim_intent(by=<explorer-agent-id>)
explorer:  decx_explorer_add_candidate(by=<explorer-agent-id>)
explorer:  decx_explorer_conclude_intent(by=<explorer-agent-id>)
mainAgent: decx_planner_spawn_evaluator
evaluator: decx_evaluator_verdict(by=<evaluator-agent-id>)
metacog:   decx_metacog_add_hint(by=<metacog-agent-id>) when the graph drifts or stalls
mainAgent: decx_planner_create_intent(parentHintIds=[...]) or decx_planner_respond_hint
mainAgent: decx_planner_fail_intent only when an accepted fact justifies failure
```


## Cross-Session Analysis

Use these when comparing different apps or different runs:

```text
decx_cross_graphs
decx_cross_search query="exported provider" graphIds=[appA,appB] nodeTypes=[facts] status=accepted
decx_cross_compare_facts graphIds=[appA,appB]
```

These are read-only. If a cross-app pattern should affect the current analysis, Planner must explicitly write a current-session fact/hint/intent through normal Planner functions.

## Architecture

See `.opencode/ARCHITECTURE.md` for the full module map and control flow.

Key points:

- `.opencode/plugins/decx.js` composes the base plugin with the analysis profile registry.
- `.opencode/plugins/lib/base-plugin.js` is the reusable hook/tool entrypoint and subagent orchestrator.
- `.opencode/plugins/profiles/index.js` selects the active profile by agent name, `kind`, or session domain.
- `.opencode/plugins/profiles/<profile-id>/index.js` injects profile role prompts, knowledge routing, scripts, and profile asset env vars.
- `.opencode/plugins/profiles/<profile-id>/knowledge-base/` contains profile-owned compact knowledge topics.
- `.opencode/plugins/profiles/<profile-id>/scripts/` contains profile-owned helper scripts.
- `.opencode/plugins/lib/decx-graph.js` embeds the Fact / Intent / Hint / Agent graph engine.
- `.opencode/plugins/lib/graph-api.js` exposes named function wrappers over the graph engine.
- `.opencode/plugins/lib/blackboard-policy.js` owns system text and bypass blocking.
- The plugin writes heartbeat, logs, and timelines under `.decx/opencode-plugin/`.

## Troubleshooting

### Plugin not loading

1. Check logs: `opencode run --print-logs "hello" 2>&1 | grep -i decx`
2. Verify the plugin line in `opencode.json`
3. Confirm `.decx/opencode-plugin/.plugin-heartbeat` is created after OpenCode starts

### DECX tools not found

1. Verify the installed plugin has `.opencode/plugins/decx.js`
2. Restart OpenCode after updating the plugin
3. Check `.decx/opencode-plugin/logs/plugin_debug.log`

### Role function denied

This is expected when a role tries to call another role's function, or when the active OpenCode agent name does not identify a DECX role. Use `mainAgent`/`planner`, `explorer`, `evaluator`, or `metacog` agent names.

### Planner action blocked by open hints

Planner must respond to open hints before continuing ordinary planning or spawning work. Use `decx_planner_create_intent(parentHintIds=[...])`, `decx_planner_respond_hint`, `decx_planner_stop_agent(hintIds=[...])`, or `decx_planner_fail_intent(hintIds=[...])`.

### Raw graph shell command blocked

Direct shell use of graph scripts or `decx-analysis.db` is intentionally blocked by `tool.execute.before`.

## Getting Help

- Report issues: https://github.com/jygzyc/decx/issues
