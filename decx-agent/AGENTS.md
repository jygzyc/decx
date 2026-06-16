# AGENTS.md

Coding guidance for the optional TypeScript `decx-agent` package.

- `decx-agent` is a standalone npm package (`@jygzyc/decx-agent`) with its own `decx-agent` binary. It has no dependency on `decx-cli`.
- Treat `decx-agent` as a generic configured agent framework. Do not add fixed business task subcommands.
- SQLite is the primary runtime state store; session directories keep `task.json` and prompts.
- `task.json` schema: `task`, `roles`, `tools`, `workflow`, and `workers`.
- Role prompts may come from markdown files relative to the session directory; inline `instructions` append to the resolved role prompt.
- Tools and skills are declared in the top-level `tools` map and selected per role with `role.tools`; keep this layer separate from worker backends.
- Role autonomy is enforced at runtime after worker JSON parsing and before state is mutated.
- Workflow review policy lives under `workflow.review`, not a top-level reviewer field.

## Schema

SQLite stores 7 tables: `projects`, `facts`, `intents`, `intent_sources`, `links`, `runs`, `meta`.

- `facts` are immutable observation nodes with `confidence` (0.0–1.0).
- `intents` are work units with lifecycle (`open`→`working`→`done`/`failed`). Their source facts are stored in the `intent_sources` edge table (real foreign keys, traversable via recursive CTE).
- `links` are directed reasoning dependencies between facts with arbitrary labels in `kind` (e.g. `enables`, `bypasses`, `calls`).
- `runs` record each worker execution (stdout/stderr preview, returncode, timing).
- `WorkflowEvent` is an in-memory protocol object for workflow rule matching — it is NOT persisted. The dispatcher builds events, passes them to the rule matcher, then discards them.

The graph IS the storage. There is no dual-write to a separate graph layer. `repository.ts` provides `proofChain()`, `descendants()` via recursive CTE traversals over `intent_sources` and `links`.

## Workers

Two worker schemes, both thin adapters:

- `kind: "agent"` — CLI agent invoked as a subprocess. `AgentDriver` resolves a registered `AgentAdapter` (under `config.backend`, or falls back to `config.command` as an inline ProcessAdapter), renders argv via `buildArgv`, spawns the agent, captures stdout.
- `kind: "api"` — direct model API call. `ApiDriver` calls a registered `ModelProvider` (openai, anthropic, openai-compatible). No agent loop.

`WorkerKind` is `"agent" | "api"`.

### Agent Backends (`src/workers/agent-backends/`)

Transport-agnostic `AgentBackend` interface (`invoke()`). Two transport families:

| Backend | Agent | Transport | How |
|---|---|---|---|
| `claude-code` | `claude` | subprocess | `claude --dangerously-skip-permissions -p -- <prompt>` |
| `codex` | `codex exec` | subprocess | `codex exec --model <m> ... -- <prompt>` |
| `opencode` | `opencode run` | subprocess | `opencode run <prompt>` |
| `opencode-http` | opencode server | HTTP | `POST /session/:id/message` to `opencode serve` |
| `process` | (any) | subprocess | `<command> <args...>` with prompt via stdin |

To use opencode-http, set `transport: "http"` + `baseUrl` + optional `password` in task.json. The `opencode serve` process must be running. Custom backends implement `AgentBackend` and register via `registerAgentBackend(backend)`.

### Model Providers (`src/workers/providers/`)

- `openai`, `openai-compatible`, `anthropic` are built-in and wrap the official SDKs.
- Custom providers: implement `ModelProvider` and register via `registerProvider(provider)`.

## General

- Keep worker backends as thin command/API adapters.
- Worker ids are strings. Configured workers may add agent adapters and any registered `ModelProvider`.
- Keep task logic independent from domain-specific skills or deterministic CLI assumptions.
- Do not add Python or `uv` dependencies.
- Validate changes with `cd decx-agent && npm run build && npm run smoke`.
