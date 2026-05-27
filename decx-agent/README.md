# DECX Agent

`decx-agent` is a small fact/intent exploration engine for DECX-driven Android analysis.

It follows a Cairn-style board model:

- `Fact`: an evidence-backed analysis statement.
- `Intent`: one narrow direction to explore next.
- `Hint`: human guidance that workers should read before choosing or executing work.

The core has only three task shapes:

- `bootstrap`: create the first useful fact and initial intents.
- `explore`: claim one open intent and conclude it with one fact.
- `reason`: read the whole board, decide whether the goal is complete, or create new intents.

Worker backends are replaceable. The Python core ships `noop`, `codex`, `claude-code`, and `opencode` drivers. OpenCode integration is also a thin JavaScript plugin that calls this Python CLI.

Runtime: `uv`.

DECX core access is internal to the dispatcher. Workers request `probes` such as
`get_app_manifest`, `search_global_key`, or `get_method_context`; the Python
dispatcher performs the HTTP request against `/api/decx/*` and records the
observation as a fact. Workers should not shell out to `decx-cli`.

Server lifecycle is config-driven. `decx-agent` reads `decx-agent.json` from the
project root, or a path passed with `--config`. Use `server.mode = external`
when DECX is already running, `managed` when the agent should start
the GitHub-release `decx-server.jar` installed by `decx self install`, or
`disabled` for board-only runs. Managed mode looks at `server.jar`,
`DECX_SERVER_HOME`, then `DECX_HOME/bin/decx-server.jar` or
`~/.decx/bin/decx-server.jar`; it does not use this repository's Gradle build
output.

## Commands

```bash
cd decx-agent
uv run decx-agent --project-root .. run sample.apk --dry-run
uv run decx-agent --project-root .. --artifact-root /tmp/decx-runs run sample.apk
uv run decx-agent --project-root .. --config ../decx-agent.json run sample.apk
uv run decx-agent status ../.decx-analysis/sample/run.json
uv run decx-agent hint ../.decx-analysis/sample/run.json "Focus on exported services"
uv run decx-agent workers
```

There are no public server or raw API commands. `run` is the task entrypoint;
DECX server startup and HTTP calls are dispatcher internals.

Run state lives at:

```text
.decx-analysis/<target>/run.json
```

The worker protocol is JSON-only. Workers do not own the board. They receive a prompt and return one structured object; the Python dispatcher writes facts, intents, hints, and completion state.

## Source Layout

```text
decx_agent/
  cli.py
  core/
    board.py      # Fact / Intent / Hint board
    agent.py      # dispatcher loop and board mutation
    store.py      # run.json read/write
    protocol.py   # worker JSON contract
    prompts.py    # worker prompts from board + skills + probes
    skills.py     # mode -> skills/*/SKILL.md references
  decx/
    client.py     # direct DECX HTTP probe client
  workers/
    base.py        # worker request/result/driver protocol
    command.py     # shared subprocess-backed worker adapter
    noop.py        # deterministic dry-run worker
    codex.py       # Codex CLI adapter
    claude_code.py # Claude Code adapter
    opencode.py    # OpenCode adapter
    __init__.py    # worker registry
```

## Boundaries

- `core/board.py`: owns the Cairn-style graph shape.
- `core/agent.py`: owns dispatcher decisions and DECX probe execution.
- `workers/base.py`: worker protocol shared by all backends.
- `workers/command.py`: subprocess-backed adapter with DECX worker env.
- `workers/`: bottom adapters only (`noop`, `codex`, `claude-code`, `opencode`).
- `core/skills.py`: maps an analysis mode to local `skills/*/SKILL.md` references.
- `core/prompts.py`: builds worker prompts from the board, capabilities, and skill references.
- `decx/client.py`: direct DECX core HTTP client for `/api/decx/*`.
- `decx/server.py`: internal managed DECX server helper, driven by config.

Worker requests carry `references` and also expose them through
`DECX_WORKER_REFERENCES` and `DECX_WORKER_REFERENCES_JSON` for command-backed
agents. Backends may read those files, but they must not write board state
directly.
