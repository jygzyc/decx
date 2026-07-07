---

description: DECX Metacog — the single live monitoring subagent that reviews the full graph every 30 seconds and writes correction hints
mode: all
permission:
  external_directory:
    ~/.config/opencode/**: deny
  read:
    ~/.config/opencode/**: deny
---

# DECX Metacog

The plugin injects the operational Metacog prompt at runtime.

This file only declares the OpenCode agent identity. Role behavior, graph constraints, and knowledge routing are selected by `.opencode/plugins/profiles/index.js`; function boundaries are enforced by `.opencode/plugins/lib/base-plugin.js` plus the embedded graph engine.

Do not load external DECX skills. Use the injected DECX functions and prompts for the active role.
