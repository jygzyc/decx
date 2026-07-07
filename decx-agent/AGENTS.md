# AGENTS.md

Coding guidance for the optional TypeScript `decx-agent` package.

## Package role

- `decx-agent` is a standalone npm package (`@jygzyc/decx-agent`) with its own `decx-agent` binary.
- Treat it as a generic configured agent runtime. Do not add fixed business task subcommands.
- Keep domain-specific behavior in task config, prompts, rules, and skills rather than hardcoding it in source.

## Architecture

`decx-agent` implements a profile-driven subagent control plane:

```text
GlobalSupervisor / AgentRuntime
  -> manages multiple SessionLoops
  -> global resource scheduling, worker quota, HTTP/API
  -> owns the cross-session FederationBus

SessionLoop(session)
  -> owns the session-local Graph
  -> owns the session-local MainAgent / Planner
  -> owns the session-local MetacogSupervisor
  -> creates / cancels session-local SubagentRuns
  -> writes back to the session Graph via permission-checked DecisionApplier

SubagentProfile
  = runtime + prompt + context policy + permissions + output contract + maxActive

Graph
  = single source of truth per session: Fact / Intent / Hint / Directive / Link / Event / SubagentRun
```

Core principles:

1. Source implements mechanism only — no hardcoded role semantics.
2. Roles, prompts, models, workers, permissions, and context policies come from configuration.
3. The Graph is the single session-local source of truth.
4. Main loop is easy to find: `session/session-loop.ts` (per-session) and `session/supervisor.ts` (global).
5. Explorer / Evaluator / Metacog are trackable, cancellable, configurable SubagentRuns.
6. Each active session has its own MainAgent/Planner and Metacog; the global layer only supervises.
7. Session-internal sync goes through Graph/events; cross-session insight goes through FederationBus (read-only summary + refs, never cross-session graph writes).

Future evolution and rationale live in `../docs/decx-agent-subagent-control-plane-plan.md` (path is relative to the repo root, not this package).

## Source layout

```text
src/
├── app/       # runtime composition root (AgentRuntime)
├── config/    # task/default/provider config, profile-loader, prompt-loader
├── session/   # SessionLoop, GlobalSupervisor, MetacogSupervisor, SessionManager, ProjectLock
├── agent/     # MainAgent, DecisionApplier, contracts, permissions, context-builder, graph-view,
│              # parse-envelope, prompts/builtins, and the legacy Stage implementations
├── graph/     # Graph interface, SQLite/InMemory stores, FederatedGraph, FederationBus
├── worker/    # worker runtime, drivers, backends, providers, mock worker
├── server/    # HTTP API and embedded dashboard
├── cli.ts     # CLI entrypoint
└── index.ts   # public exports
```

## Config model

`task.json` is profiles-first:

```text
task
profiles
workers
workflow
control
```

Important points:

- `task.target` and `task.goal` are required.
- `profiles` declares SubagentProfiles. The built-in slots are `planner`, `explorer`, `evaluator`, and optional `metacog`; custom profiles (e.g. `source-finder`, `strict-reviewer`) live under arbitrary keys.
- A SubagentProfile binds together: `runtime` (worker + optional model), `prompt` (file/text/rules/knowledge), `context` (graphView + maxFacts), `permissions` (capability tokens), `output` (contract name), `maxActive`, `intervalSeconds`.
- Legacy flat fields (`worker`, `workers`, `prompt`, `promptText`) are still accepted and normalized by ProfileLoader onto the structured spec.
- `workers` defines low-level worker configs (`kind: "agent" | "api" | "mock"`).
- `workflow.limits`, `workflow.metacog`, and `workflow.stopGate` tune scheduling and termination.
- `control.mainProfile`, `control.metacogProfile`, and `control.metacogIntervalSeconds` select which profiles drive planning and metacognition.

## Graph model

Graph state is session-local and is the source of truth:

- Projects
- Facts (`candidate` -> `accepted` / `rejected`)
- Intents (`open` -> `claimed` / `chained` / `done` / `failed`)
- Hints
- Directives
- Links
- Events
- SubagentRuns (`pending` -> `running` -> `completed` / `failed` / `cancelled`)
- Dead-end route hashes

Do not introduce domain-specific fact enums. Keep domain meaning in descriptions, evidence, prompts, and references.

## Agent protocol layer

- `agent/permissions.ts` — PermissionChecker enforces per-profile capability tokens before any graph mutation.
- `agent/contracts.ts` — named output validators (main_decision, candidate_fact, verdict, hints, stop, chain).
- `agent/context-builder.ts` — assembles dynamic prompt context from the graph per profile.context.
- `agent/graph-view.ts` — renders graph state per view policy (full / focused / evidence-only / summary).
- `agent/main-agent.ts` — session-local MainAgent wrapper around the planner profile.
- `agent/decision-applier.ts` — applies MainDecision to the graph with permission checks.
- `agent/parse-envelope.ts` — JSON envelope extraction shared by stages, contracts, and the applier.

## Workers

Worker adapters are bottom-layer execution only. They must not own graph state or scheduling policy.

- `src/worker/agent-driver.ts` handles agent CLI/HTTP backends.
- `src/worker/api-driver.ts` handles direct model API providers.
- `src/worker/backends/` contains OpenCode, Codex, Claude Code, HTTP, and custom process adapters.
- `src/worker/providers/` contains direct model provider wiring.

Backends should stay thin: prompt in, text/process result out.

## Validation

Run from inside `decx-agent/`:

```bash
npm run build
npm test
npm run smoke
```

`npm test` builds first. `npm run smoke` assumes `dist/cli.js` exists, so run `npm run build` before smoke if needed.
