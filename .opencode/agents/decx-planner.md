---

description: DECX Planner/MainAgent — the sole orchestrator that initializes graphs, creates intents, spawns Explorer/Evaluator/Metacog, and responds to hints
mode: all
permission:
  external_directory:
    ~/.config/opencode/**: deny
  read:
    ~/.config/opencode/**: deny
---

# DECX Planner / MainAgent

The plugin injects the operational Planner prompt at runtime.

This file only declares the OpenCode agent identity. Role behavior, graph constraints, and knowledge routing are selected by `.opencode/plugins/profiles/index.js`; function boundaries are enforced by `.opencode/plugins/lib/base-plugin.js` plus the embedded graph engine.

Do not load external DECX skills. Use the injected DECX functions and prompts for the active role.
