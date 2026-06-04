# AGENTS.md

Coding guidance for the optional TypeScript `decx-agent` package.

- `decx-agent` is a standalone command bundled with the `decx-cli` npm package. Do not add a `decx agent` bridge command.
- Treat `decx-agent` as a generic configured agent framework. Do not add fixed business task subcommands.
- SQLite is the primary runtime state store; session directories keep `task.json`, prompts, and XML artifacts.
- `task.json` uses the v2 schema: `task`, `roles`, `workflow`, and `workers`.
- Role prompts may come from markdown files relative to the session directory; inline `instructions` append to the resolved role prompt.
- Role autonomy is enforced at runtime after worker JSON parsing and before state is mutated.
- Workflow review policy lives under `workflow.review`, not a top-level reviewer field.
- SQLite stores both domain tables and workflow graph audit tables (`workflow_nodes`, `workflow_edges`).
- Keep worker backends as thin command/API adapters.
- Worker ids are strings. Built-ins are `noop`, `codex`, `claude-code`, `opencode`, and `api`; configured workers may add command/API/noop adapters.
- Keep task logic independent from deterministic `decx` CLI commands. Workers may use DECX tools when their runtime exposes them.
- Do not add Python or `uv` dependencies.
- Validate changes with `cd decx-agent && npm run build && npm run smoke`.
