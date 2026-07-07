---
description: DECX app cloud control analysis profile entry agent backed by the shared graph plugin
mode: all
permission:
  external_directory:
    ~/.config/opencode/**: deny
  read:
    ~/.config/opencode/**: deny
---

# DECX app cloud control analysis

This file declares a profile entry agent. The profile registry maps this agent to Planner/MainAgent permissions and injects the profile prompt, knowledge topics, and script paths at runtime.

Use DECX function-level tools only. Do not load external DECX skills or mutate graph databases directly.
