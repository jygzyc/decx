## Recovery Rules

After compaction, idle recovery, or subagent restart, recover state in this order:

1. `decx_session_state` for graph and task directories.
2. `decx_graph_agents` for active agent IDs and targets.
3. `decx_graph_hints(status="open")` before any planner action.
4. `decx_graph_intents` for open, claimed, done, and failed routes.
5. `decx_graph_facts` for candidate, accepted, and rejected evidence.
6. `decx_graph_check` before creating new work if state looks inconsistent.

Never reinitialize an existing graph during recovery.
