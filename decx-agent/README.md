# decx-agent

`decx-agent` is a generic TypeScript agent framework bundled as a standalone command. It runs configured tasks, stores the Fact/Intent/Hint graph in SQLite, dispatches workers, and exposes a local audit UI.

There is no `decx agent` subcommand.

## Commands

```bash
decx-agent run .decx/agent_tasks/<session>/task.json
decx-agent run .decx/agent_tasks/<session> --worker noop --max-steps 3
decx-agent resume <session-or-project>
decx-agent status <session-or-project>
decx-agent workers
decx-agent serve --host 127.0.0.1 --port 25429
```

Business workflows are defined by `task.json`, prompts, roles, and workflow rules instead of fixed CLI subcommands.

## Build And Package

```bash
npm run build
npm run smoke
npm run pack
```

`pack` rebuilds the agent, writes the compressed npm tarball to `dist-packages/`, and emits `dist-packages/manifest.json` with package name, version, compressed size, unpacked size, and SHA-256.

## Session Workspace

```text
.decx/agent_tasks/<session>/
  task.json
  prompts/
```

The default SQLite database is:

```text
.decx/agent_tasks/agent.sqlite
```

## Minimal Task Config

```json
{
  "task": {
    "name": "example",
    "target": "input",
    "goal": "Complete one configured task."
  },
  "worker": "noop",
  "tools": {
    "notes": {
      "kind": "tool",
      "description": "Record concise task notes",
      "instructions": "Use only when the current task needs durable notes."
    }
  },
  "roles": {},
  "workflow": {
    "phases": [
      { "id": "bootstrap", "role": "planner" },
      { "id": "reason", "role": "evaluator" },
      { "id": "explore", "role": "generator" },
      { "id": "review", "role": "evaluator" }
    ],
    "rules": []
  }
}
```

Roles can be defined with prompt files:

```json
{
  "roles": {
    "cloudTracer": {
      "extends": "generator",
      "prompt": "prompts/cloud-control-trace.md",
      "instructions": "Focus on cloud-control parameter propagation.",
      "worker": "codex",
      "tools": ["notes"],
      "autonomy": {
        "canCreateIntents": true,
        "maxIntentsPerStep": 2
      }
    }
  }
}
```

## Tools And Skills

`tools` is a separate task layer from workers. Workers execute prompts; tools and skills describe capabilities the worker may use.

```json
{
  "tools": {
    "repoSearch": {
      "kind": "tool",
      "description": "Search files in the current repository",
      "command": "rg",
      "args": ["{{query}}"],
      "instructions": "Prefer focused queries and cite matching files."
    },
    "reviewGuide": {
      "kind": "skill",
      "description": "Code review checklist",
      "prompt": "prompts/review-guide.md"
    }
  },
  "roles": {
    "evaluator": {
      "tools": ["repoSearch", "reviewGuide"]
    }
  }
}
```

If a role omits `tools`, the prompt exposes all configured tools.

Reviewer can run asynchronously from workflow config:

```json
{
  "workflow": {
    "review": {
      "enabled": true,
      "role": "evaluator",
      "worker": "api",
      "everySteps": 5,
      "prompt": "prompts/evaluator.md"
    }
  }
}
```

API worker configuration is optional:

```json
{
  "workers": {
    "api": {
      "kind": "api",
      "provider": "openai-compatible",
      "baseUrl": "https://api.openai.com/v1",
      "model": "gpt-4.1",
      "apiKeyEnv": "OPENAI_API_KEY"
    },
    "localCodex": {
      "kind": "command",
      "command": "codex",
      "args": ["exec", "{{prompt}}"],
      "sessionStrategy": "regex",
      "sessionPattern": "session id:\\s*([0-9a-fA-F-]+)"
    }
  }
}
```

Command workers support `{{prompt}}`, `{{session}}`, `{{projectId}}`, `{{phase}}`, `{{role}}`, `{{sessionDir}}`, and `{{intentId}}` argument placeholders. `sessionStrategy` may be `none`, `stable`, `uuid`, or `regex`; `responseMode: "jsonl-assistant-text"` extracts the last assistant text from JSONL agent events.

Runtime state includes a workflow graph in SQLite. `status` and `export` return graph nodes and edges alongside facts, intents, events, reviews, and worker runs.
