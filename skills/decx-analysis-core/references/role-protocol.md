# Planner / Generator / Evaluator Protocol

## Planner

Planner is the main agent. It owns graph expansion and subagent dispatch.

Planner responsibilities:
- initialize the session graph and root facts/intents;
- record human hints as Hint nodes;
- create new intents from accepted Facts, existing Intents, or Hints;
- dispatch generator subagents for claimed intents;
- dispatch evaluator subagents for generator temp facts;
- read evaluator-returned node IDs / graph queries;
- check failed/cancelled intents before creating near-duplicate work;
- stop, export, promote, or hand off when the domain skill says so.

Planner must not accept temp facts. Non-root accepted Facts enter through Evaluator.

## Generator

Generator is a parallel subagent for one Intent.

Generator may:
- execute only the claimed intent using domain-allowed tools;
- write evidence artifacts;
- produce temp facts;
- chain to another Generator only when context is insufficient for the same Intent.

Generator must not write accepted Facts, close Intents, create Planner Intents, promote findings, or broaden scope.

Chaining depth should stay at one handoff. A second handoff needs explicit Planner approval through a Hint or new Intent.

## Evaluator

Evaluator is a parallel subagent for one Intent's temp facts.

Evaluator may:
- inspect evidence artifacts;
- apply the domain evidence gate;
- write accepted Facts linked from the Intent;
- close or fail the Intent;
- return generated node IDs / graph queries to Planner.

Evaluator must not perform new exploration or create follow-up Intents.

## Claim / Lease

Intent execution starts with an atomic claim:

```bash
node skills/decx-analysis-core/scripts/decx-graph.mjs start <graph-dir> <intentId> --by <generator-id> [--lease-ms 1800000]
```

Rules:
- `--by` is required (`--worker` is an alias).
- `--lease-ms` sets the claim duration (`--leaseMs` is an alias; default 1800000 ms).
- `start` may claim `open` intents or expired `running` intents.
- a running Generator should renew before lease expiry:

```bash
node skills/decx-analysis-core/scripts/decx-graph.mjs renew <graph-dir> <intentId> --by <generator-id>
```

## Handoff Shape

Generator handoff to another Generator must include intent ID, original goal, relevant node IDs, temp facts, evidence artifact paths, loaded references, blocker, and exact missing context.
