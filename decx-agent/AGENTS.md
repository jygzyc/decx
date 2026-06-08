# AGENTS.md

Coding guidance for the optional TypeScript `decx-agent` package.

- `decx-agent` is a standalone command bundled with the `decx-cli` npm package. Do not add a `decx agent` bridge command.
- Treat `decx-agent` as a generic configured agent framework. Do not add fixed business task subcommands.
- SQLite is the primary runtime state store; session directories keep `task.json` and prompts.
- `task.json` uses the v2 schema: `task`, `roles`, `tools`, `workflow`, and `workers`.
- Role prompts may come from markdown files relative to the session directory; inline `instructions` append to the resolved role prompt.
- Tools and skills are declared in the top-level `tools` map and selected per role with `role.tools`; keep this layer separate from worker backends.
- Role autonomy is enforced at runtime after worker JSON parsing and before state is mutated.
- Workflow review policy lives under `workflow.review`, not a top-level reviewer field.
- SQLite stores both domain tables and workflow graph audit tables (`workflow_nodes`, `workflow_edges`).
- Keep worker backends as thin command/API adapters.
- Worker ids are strings. Built-ins are `noop`, `codex`, `claude-code`, `opencode`, `api`, `openai`, `anthropic`, and `openai-compatible`; configured workers may add command/noop adapters and any registered `ModelProvider`.
- `WorkerKind` is `"noop" | "command" | "model"`. The legacy `api` kind was a synonym for `model` and has been removed from the enum; the built-in `api` worker name still resolves to `kind: "model"`.
- Model workers are dispatched through `src/workers/providers/`, which wraps the official `openai` and `@anthropic-ai/sdk` SDKs. New providers register via `registerProvider(...)` and are matched by id in `task.json`'s `worker.provider` or the `DECX_AGENT_API_PROVIDER` env var. No source edit is required to add a provider.
- Keep task logic independent from domain-specific skills or deterministic CLI assumptions.
- Do not add Python or `uv` dependencies.
- Validate changes with `cd decx-agent && npm run build && npm run smoke`.
