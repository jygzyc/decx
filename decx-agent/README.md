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

Business workflows such as vulnerability hunting, cloud-control analysis, attribution, or parameter reversal are defined by `task.json`, prompts, roles, and workflow rules instead of fixed CLI subcommands.

## Build And Package

```bash
npm run build
npm run smoke
npm run pack:agent
```

`pack:agent` rebuilds the agent, writes the compressed npm tarball to `dist-packages/`, and emits `dist-packages/manifest.json` with package name, version, compressed size, unpacked size, and SHA-256.

## Session Workspace

```text
.decx/agent_tasks/<session>/
  task.json
  prompts/
  artifacts/
```

The default SQLite database is:

```text
.decx/agent_tasks/agent.sqlite
```

## Minimal Task Config

```json
{
  "task": {
    "name": "sieve-cloud-control",
    "target": "target.apk",
    "goal": "Analyze cloud-control decision paths."
  },
  "worker": "noop",
  "roles": {},
  "workflow": {
    "phases": [
      { "id": "bootstrap", "role": "planner" },
      { "id": "reason", "role": "dispatcher" },
      { "id": "explore", "role": "explorer" },
      { "id": "review", "role": "reviewer" }
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
      "extends": "explorer",
      "prompt": "prompts/cloud-control-trace.md",
      "instructions": "Focus on cloud-control parameter propagation.",
      "worker": "codex",
      "autonomy": {
        "canCreateIntents": true,
        "maxIntentsPerStep": 2
      }
    }
  }
}
```

Reviewer can run asynchronously from workflow config:

```json
{
  "workflow": {
    "review": {
      "enabled": true,
      "role": "reviewer",
      "worker": "api",
      "everySteps": 5,
      "prompt": "prompts/reviewer.md"
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
      "args": ["exec", "{{prompt}}"]
    }
  }
}
```

Runtime state includes a workflow graph in SQLite. `status` and `export` return graph nodes and edges alongside facts, intents, events, reviews, artifacts, and worker runs.
