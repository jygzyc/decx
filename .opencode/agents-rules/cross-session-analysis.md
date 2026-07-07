## Cross-Session Analysis

- Cross-session tools are read-only federation tools.
- Use `decx_cross_graphs` to discover comparable session DBs.
- Use `decx_cross_search` to find repeated facts, intents, or hints across apps.
- Use `decx_cross_compare_facts` to group accepted facts across sessions.
- Never use a foreign graph node ID as current-session proof.
- If a foreign pattern matters, Planner writes a current-session fact, hint, or intent that cites the source graph as evidence context.
