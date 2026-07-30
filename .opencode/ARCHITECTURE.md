# DECX OpenCode Plugin Architecture

DECX's OpenCode integration follows the same structural idea as OpenSecurity's plugin: the plugin is not just a tool registry. It is the runtime control plane for the workflow.

## Directory Layout

```text
.opencode/
├── agents/                     # DECX OpenCode agents: planner/explorer/evaluator/metacog
├── agents-rules/                # Shared operating rules inspired by OpenSecurity
├── plugins/
│   ├── decx.js                  # Thin profile composition entrypoint
│   ├── lib/
│   │   ├── base-plugin.js       # Reusable graph/hook/subagent substrate
│   │   ├── blackboard-policy.js # System injection text and raw bypass blocking
│   │   ├── constants.js         # Paths, role function map, domain profiles
│   │   ├── context.js           # Plugin-global context
│   │   ├── decx-graph.js        # Embedded Fact / Intent / Hint / Agent SQLite engine
│   │   ├── federation.js        # Cross-session read-only graph federation
│   │   ├── graph-api.js         # Function-level graph API wrappers
│   │   ├── logging.js           # Heartbeat and rotating debug log
│   │   ├── roles.js             # Role names, aliases, and tool allowlists
│   │   ├── session-manager.js   # Per-session agent state
│   │   ├── snippets.js          # Cached profile/rule snippet loader
│   │   ├── task-session.js      # Session task directory and summary persistence
│   │   └── timeline.js          # Per-session event timeline
│   └── profiles/
│       ├── index.js             # Analysis profile registry
│       ├── shared/              # Profile factory/helpers
│       ├── android-app-analysis/
│       ├── android-framework-analysis/
│       ├── app-cloud-control-analysis/
│       └── web-analysis/
│           ├── index.js         # Profile prompts, knowledge routing, profile tools
│           ├── knowledge-base/  # Profile-owned compact knowledge topics
│           └── scripts/         # Profile-owned helper scripts
└── INSTALL.md
```

## Runtime Model

The plugin owns the DECX workflow. No external prompt path is registered by `config()`.

OpenCode hooks provide hard runtime control:

| Hook | Responsibility |
|---|---|
| `chat.message` | Create/update session state and record current agent name. |
| `experimental.chat.system.transform` | Inject plugin-active status, graph engine path, and function-level role rules. |
| `experimental.session.compacting` | Preserve graph/session recovery instructions during context compaction. |
| `shell.env` | Export only plugin-owned DECX environment variables. |
| `tool.execute.before` | Record timeline and block direct graph/database bypass attempts. |
| `tool.execute.after` | Record tool completion in the timeline. |
| `event` | Flush timelines and clean session state. |


## Session Isolation

Every main OpenCode analysis session gets an independent SQLite database by default:

```text
.decx-analysis/<main-session-id>/decx-analysis.db
```

`graphDir=default` resolves to that session directory. Planner-spawned Explorer, Evaluator, and Metacog child sessions inherit the parent graph directory, so subagents collaborate on the same analysis graph without mixing with other user sessions. Explicit `graphDir` is still accepted for deliberate manual routing.

Cross-session analysis is supported through a read-only federation layer. It enumerates isolated DBs under `.decx-analysis/` and can search/export/compare multiple graphs without merging them or granting cross-DB writes.

## Role Model

The plugin's role shape has Planner as the main orchestrator:

```text
planner/mainAgent | explorer | evaluator | metacog | system
```

- Planner/MainAgent initializes the graph, creates intents, creates/stops subagents, responds to hints, and fails intents with accepted evidence.
- Explorer is a planner-created subagent bound to one intent. It executes and writes candidate facts only.
- Evaluator is a planner-created subagent bound to one candidate fact. It only accepts/rejects/demotes facts.
- Metacog is the single live monitoring subagent. It reviews the full graph every 30 seconds and writes hints.
- System is represented by plugin hooks, not a public write function.

## Graph Control Plane

The embedded graph engine stores one SQLite database per analysis graph directory:

```text
.decx-analysis/<main-session-id>/decx-analysis.db
```

The persisted objects are:

| Object | Purpose |
|---|---|
| Fact | Evidence assertion with `candidate`, `accepted`, or `rejected` lifecycle. |
| Intent | Concrete bounded work item with `open`, `claimed`, `done`, or `failed` lifecycle. |
| Hint | Correction/control input with `open`, `responded`, or `ignored` lifecycle. |
| Agent | Runtime subagent record for explorer, evaluator, or metacog. |

The proof chain is `Fact -> Intent -> Fact`. The correction chain is `Hint -> Intent -> Fact` or `Hint -> Planner decision`. Hint is not evidence; it is control input that Planner must explicitly respond to.

Links are internal provenance edges generated by graph functions. There is no public manual link writer.

## Function-Level Permissions

The plugin does not expose a generic `command` tool. Each public OpenCode tool is one fixed function, and its implementation calls a named wrapper in `graph-api.js`. This makes the function itself the permission boundary; callers cannot smuggle a different graph operation through an `args` array.

| Role | Public functions |
|---|---|
| Planner/MainAgent | `decx_planner_init`, `decx_planner_add_root_fact`, `decx_planner_create_intent`, `decx_planner_add_human_hint`, `decx_planner_respond_hint`, `decx_planner_fail_intent`, `decx_planner_spawn_explorer`, `decx_planner_spawn_evaluator`, `decx_planner_stop_agent`, `decx_planner_start_metacog`, `decx_planner_restart_metacog` |
| Explorer | `decx_explorer_claim_intent`, `decx_explorer_renew_intent`, `decx_explorer_add_candidate`, `decx_explorer_conclude_intent` |
| Evaluator | `decx_evaluator_verdict` |
| Metacog | `decx_metacog_add_hint`, `decx_metacog_heartbeat` |
| Read-only current graph | `decx_graph_facts`, `decx_graph_intents`, `decx_graph_hints`, `decx_graph_agents`, `decx_graph_links`, `decx_graph_path`, `decx_graph_ancestors`, `decx_graph_descendants`, `decx_graph_chains`, `decx_graph_proof_chains`, `decx_graph_export`, `decx_graph_check` |
| Read-only cross graph | `decx_cross_graphs`, `decx_cross_export`, `decx_cross_search`, `decx_cross_compare_facts` |
| Session state | `decx_session_state` |
| Profile assets | `decx_knowledge`, `decx_profile_assets` |

The tool execution path checks the active OpenCode agent name before any role-scoped write. Planner also accepts `mainAgent` / `main-agent` naming. Cross-role and unknown-role writes are rejected before the graph engine runs.

The graph engine also checks subagent identity, not just role-shaped input. Explorer writes must include the active Explorer agent ID in `by` and must target the intent claimed by that same agent. Evaluator verdicts must include the active Evaluator agent ID in `by` and must target that evaluator's assigned candidate fact. Metacog hints must include the active Metacog agent ID in `by`; inactive, stopped, or mismatched agents are rejected.

Knowledge-base topics are compact, on-demand references owned by each profile. The profile registry currently includes `android-app-analysis`, `android-framework-analysis`, `app-cloud-control-analysis`, and `web-analysis`. Each profile injects only its topic index by default; agents load one specific topic through `decx_knowledge` when a current intent needs it. Knowledge output is a lead and never bypasses accepted graph evidence.

## Profile Injection Layer

The graph engine remains role-agnostic infrastructure. `.opencode/plugins/lib/base-plugin.js` owns the graph, role-scoped function execution, session DB isolation, child-session lifecycle, and hook wiring. It does not decide which analysis role prompt or knowledge base to inject.

Analysis profiles call the base implementation and provide behavior:

- `.opencode/plugins/decx.js` composes the base graph plugin with `decxAnalysisProfiles`.
- `.opencode/plugins/profiles/index.js` selects the active profile.
- Each profile directory supplies role prompts, domain-to-knowledge routing, profile script/knowledge paths, compaction additions, and profile-specific read-only tools such as `decx_knowledge` and `decx_profile_assets`.
- Future analysis plugins should add another profile and call `createDecxGraphPlugin(profile, input)` instead of editing the base graph plugin.

This follows the OpenSecurity-style plugin/profile split while keeping authority in code: profiles route behavior and knowledge loading, but function permissions and graph identity checks remain enforced by the base plugin and graph engine.

## Hint Discipline

Hints are first-class control objects:

- Human and Metacog hints start as `open`.
- While any open hint exists, Planner cannot create ordinary intents, spawn subagents, fail intents, stop agents, or add root facts unless the action explicitly responds to the open hint.
- Explorer output is also frozen while open hints exist: it may renew its lease, but it cannot add candidate facts or conclude an intent until Planner responds.
- `decx_planner_create_intent(parentHintIds=[...])` turns `Hint -> Intent` into an explicit correction chain.
- `decx_planner_respond_hint` records non-intent responses such as ignore-with-reason or request-more-evidence.

## Subagent Lifecycle

Planner creates subagent records in the graph and, when OpenCode's client API is available, starts child OpenCode sessions with role-limited tools.

- Explorer is created for one intent and must claim that intent before writing candidate facts.
- Only one active Explorer can be bound to an intent at a time.
- Evaluator is created for one candidate fact and completes after verdict.
- Only one active Evaluator can be bound to a candidate fact at a time.
- Planner can stop any active subagent. If an Explorer is stopped, its claimed intent is released back to `open`.
- Exactly one active Metacog is allowed. The plugin starts a 30-second timer that prompts Metacog with full graph state. If Metacog context fills up, Planner stops it with `context_full` and starts a new generation.

## Intent Failure Discipline

Explorer cannot fail an intent. Evaluator cannot fail an intent. Only Planner can fail an intent, and `decx_planner_fail_intent` requires an accepted fact as evidence. This keeps failure decisions grounded in evaluator-reviewed graph state.

Explorer conclusion is also constrained by the graph engine: if Explorer concludes with a fact ID, that fact must be explorer-produced, must belong to the same intent, and must not be rejected.

`decx_graph_chains` returns raw graph paths for debugging. `decx_graph_proof_chains` returns accepted-only proof paths, excluding candidate and rejected facts so downstream reasoning cannot accidentally treat unreviewed output as truth.



## Agents and Rules

DECX now ships OpenCode agents under `.opencode/agents/`:

- `decx-planner`: explicit Planner/MainAgent.
- `decx-explorer`: single-intent executor subagent.
- `decx-evaluator`: candidate fact reviewer subagent.
- `decx-metacog`: single live graph-monitoring subagent.

Shared operating rules live under `.opencode/agents-rules/`. They are intentionally small and DECX-specific: graph discipline, planning rules, execution discipline, cross-session analysis, recovery, output format, and runtime environment.

## Task Directory and Session State

Every OpenCode session gets a task directory:

```text
.decx/opencode-plugin/tasks/<session-id>/
```

The plugin exposes it through `DECX_TASK_DIR` and `decx_session_state`. Session idle/delete events write `summary.json` in that directory. This mirrors OpenSecurity's task-dir persistence without allowing graph writes outside function-level tools.

## Cross-Session Analysis

Session DBs stay isolated for writes, but the plugin exposes read-only federation tools for comparing different applications or runs:

- `decx_cross_graphs` lists available session DBs.
- `decx_cross_export` exports selected graphs without modifying them.
- `decx_cross_search` searches facts/intents/hints across selected graphs.
- `decx_cross_compare_facts` groups repeated accepted facts across graphs.

These tools never create facts, intents, hints, links, agents, or verdicts. Any new conclusion discovered from cross-session analysis must be written back explicitly by Planner into the current session DB as a normal root fact, hint response, or intent.

## Bypass Blocking

`tool.execute.before` blocks shell commands that touch graph scripts or the graph database directly. The only supported graph write path is through the fixed function-level plugin tools.

Blocked examples:

```bash
node .../decx-graph.js ...
node .../decx-graph.mjs ...
sqlite3 .../decx-analysis.db ...
```

## State and Observability

The plugin writes operational state under:

```text
.decx/opencode-plugin/
├── .plugin-heartbeat
├── logs/plugin_debug.log
└── timelines/<session>.jsonl
```

This mirrors the OpenSecurity pattern of making plugin load state and hook activity observable without depending on model obedience.
