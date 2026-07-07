---
name: decx-poc
description: Build one Android PoC project from one finalized DECX DAG finding fact. Optional compile/deploy only when explicitly requested.
---

# DECX PoC

## Routing Gate

Use only when the user asks to build or prepare a PoC from one finalized DECX finding fact.

Do not use for vulnerability discovery, chain tracing, report generation, or generic exploit-writing advice. If no finalized finding fact exists, route back to the relevant vulnhunt skill.

Default ceiling: `build-ready` unless the user explicitly asks for compile or deploy.

## Workflow

1. Load `skills/decx-analysis-core/references/finding-consumer-contract.md`.
2. Read one finalized finding fact.
3. Re-check entry→impact path in the DAG.
4. Load `references/poc-spec.md` and build one PoC Spec.
5. Stop if the spec is incomplete.
6. Load `references/index.md` and one matching PoC reference.
7. Create/reuse project with `scripts/setup-poc.mjs`.
8. Implement one exploit id.
9. Compile/deploy only when explicitly requested.

## Commands

```bash
node skills/decx-analysis-core/scripts/decx-graph.mjs facts <graph-dir> --kind finding
node skills/decx-analysis-core/scripts/decx-graph.mjs facts <graph-dir> --kind app-finding
node skills/decx-analysis-core/scripts/decx-graph.mjs facts <graph-dir> --kind framework-finding
node skills/decx-analysis-core/scripts/decx-graph.mjs path <graph-dir> --from <entry_fact> --to <impact_fact>
node skills/decx-analysis-core/scripts/decx-graph.mjs ancestors <graph-dir> --from <impact_fact>
node skills/decx-analysis-core/scripts/decx-graph.mjs export <graph-dir>

node skills/decx-poc/scripts/setup-poc.mjs <target>
node skills/decx-poc/scripts/check-env.mjs
cd poc-<target>/app && timeout 300 ./gradlew assembleDebug --no-daemon
```

## Rules

| Rule | Rationale |
|---|---|
| One finalized finding per PoC spec | prevents contamination |
| One spec maps to one exploit id | output integrity |
| Do not create project if required spec fields are missing | stale values cause fake PoCs |
| Replace every placeholder with accepted DAG evidence | evidence-bound code |
| Framework findings use direct Binder calls | wrong delivery misses target |
| Hidden-API exemption only for framework Binder PoCs | avoid leaking framework setup into app PoCs |
| Compile/deploy only on explicit request | default is build-ready |
| Log a real proof signal, not a theory statement | usable validation |

## References

- `skills/decx-analysis-core/references/finding-consumer-contract.md`
- `references/poc-spec.md`
- `references/poc-workflow.md`
- `references/index.md`
- `references/poc-base.md`
- `assets/README.md`
- `references/poc-app-*.md`
- `references/poc-framework-service.md`
