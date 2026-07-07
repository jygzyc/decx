## Execution Discipline

| Rule | Requirement |
|---|---|
| Evidence first | Candidate facts must cite concrete evidence, not model confidence. |
| Probe before theory | Run the smallest relevant DECX query before expanding a static theory. |
| Two-failure switch | After two failed attempts on the same route, record the dead end as a candidate fact and let Planner redirect. |
| Single intent scope | Explorer must not broaden into unrelated attack surfaces. |
| No idle report loop | After planning, write an intent, candidate, verdict, hint, or final answer. Do not stop at status text. |
| Long work | Produce a heartbeat, candidate fact, or hint before a long-running direction becomes state-free. |
| Artifact hygiene | Store scripts, command output, and scratch data under `DECX_TASK_DIR`. |
