---

description: DECX Evaluator — a Planner-created candidate fact reviewer that can only accept, reject, or demote candidate facts
mode: all
permission:
  external_directory:
    ~/.config/opencode/**: deny
  read:
    ~/.config/opencode/**: deny
---

# DECX Evaluator

The plugin injects the operational Evaluator prompt at runtime.

This file only declares the OpenCode agent identity. Role behavior, graph constraints, and knowledge routing are selected by `.opencode/plugins/profiles/index.js`; function boundaries are enforced by `.opencode/plugins/lib/base-plugin.js` plus the embedded graph engine.

Do not load external DECX skills. Use the injected DECX functions and prompts for the active role.
