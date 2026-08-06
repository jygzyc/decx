---
name: decx-poc
description: Build one Android PoC project from one finalized DECX finding writeup. Optional compile/deploy only when explicitly requested.
---

# DECX PoC

## Routing Gate

Use only when the user asks to build or prepare a PoC from one finalized DECX finding.

Do not use for vulnerability discovery, chain tracing, report generation, or generic exploit-writing advice. If no finalized finding exists, route back to the relevant vulnhunt skill.

Default ceiling: `build-ready` unless the user explicitly asks for compile or deploy.

## Workflow

1. Read one finalized finding writeup.
2. Re-check the finding's entry→impact path.
3. Load `references/poc-spec.md` and build one PoC Spec.
4. Stop if the spec is incomplete.
5. Load `references/index.md` and one matching PoC reference.
6. Build the `poc-<target>/` project per the contract in `references/poc-base.md`. `<target>` must match `^[a-z][a-z0-9]*$`.
7. Implement one exploit id.
8. Compile/deploy only when explicitly requested.

Final Output — return: `state`, `projectPath`, `findingId`, `exploitId`, `trigger`, `successSignal`, `requirements`, `filesChanged`, `buildStatus`, `runtimeStatus`, `remainingManualSteps`.

## Commands

```bash
node skills/decx-poc/scripts/check-env.mjs
cd poc-<target>/app && timeout 300 ./gradlew assembleDebug --no-daemon
```

On Windows use `gradlew.bat assembleDebug --no-daemon` instead (no `timeout`).

## Rules

| Rule | Rationale |
|---|---|
| One finalized finding per PoC spec | prevents contamination |
| One spec maps to one exploit id | output integrity |
| Do not create project if required spec fields are missing | stale values cause fake PoCs |
| Replace every placeholder with finding evidence | evidence-bound code |
| Framework findings use direct Binder calls | wrong delivery misses target |
| Hidden-API exemption only for framework Binder PoCs | avoid leaking framework setup into app PoCs |
| Compile/deploy only on explicit request | default is build-ready |
| Log a real proof signal, not a theory statement | usable validation |

## References

- `references/poc-spec.md`
- `references/index.md`
- `references/poc-base.md`
- `references/poc-app-*.md`
- `references/poc-framework-service.md`
