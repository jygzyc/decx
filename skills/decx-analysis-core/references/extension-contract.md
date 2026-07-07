# Domain Skill Extension Contract

Core stores and queries only Fact / Intent / Hint DAG state. A domain skill supplies everything outside that boundary.

## Domain Must Define

| Item | Purpose |
|---|---|
| target/session setup | how Planner establishes the root context |
| root facts/intents | what Planner may initialize |
| generator capability policy | what one Generator may inspect or invoke |
| evidence artifact policy | where Generator writes re-checkable evidence |
| temp fact shape | how temporary assertions are described |
| evaluator gate | when a temp fact can become an accepted Fact |
| routing references | which domain reference files to load on which signal |
| promotion/handoff policy | when accepted facts become downstream input |

## Boundary Rules

- Domain skills define fact kinds; core does not validate them.
- Domain skills define risk, severity, finding promotion, reporting, and PoC policy.
- Domain skills must keep target-specific routing and evidence gates out of core.
- Domain skills must not add `proposal` or auto-generated `hint` concepts; persisted tasks are Intents, and Hints are human-authored only.
