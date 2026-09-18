---
name: decx-poc
description: Build one PoC project from one finalized DECX finding writeup (Android app/framework harness). Optional compile/deploy only when explicitly requested.
---

# DECX PoC

## Routing Gate

Use only when the user asks to build or prepare a PoC from one finalized DECX finding.

Do not use for vulnerability discovery, chain tracing, report generation, or generic exploit-writing advice. If no finalized finding exists, route back to `decx-vulnhunt`.

The harness set is per target: `references/android-poc-*.md` covers Android app and framework findings, and a target without a harness reference stops at the PoC spec.

Default ceiling: `build-ready` unless the user explicitly asks for compile or deploy.

## Workflow

1. Read one finalized finding writeup.
2. Re-check the finding's entry→impact path.
3. Load `references/poc-spec.md` and build one PoC Spec.
4. Stop if the spec is incomplete.
5. Load `references/index.md` and one matching PoC reference.
6. Build the `poc-<target>/` project per the harness contract (`references/android-poc-base.md` for Android). `<target>` must match `^[a-z][a-z0-9]*$`.
7. Implement one exploit id.
8. Compile/deploy only when explicitly requested.

Final Output — return: `state`, `projectPath`, `findingId`, `exploitId`, `trigger`, `successSignal`, `requirements`, `filesChanged`, `buildStatus`, `runtimeStatus`, `remainingManualSteps`.

## Commands (Android harness)

```bash
node scripts/check-env.mjs   # Android SDK/adb check; run with the decx-poc skill directory as the working directory
cd poc-<target>/app && timeout 300 ./gradlew assembleDebug --no-daemon
```

On Windows use `gradlew.bat assembleDebug --no-daemon` instead (no `timeout`). Another target's harness brings its own build command in `references/<target>-poc-base.md`.

## Rules

| Rule | Rationale |
|---|---|
| One finalized finding per PoC spec | prevents contamination |
| Framework findings use direct Binder calls (Android harness) | wrong delivery misses target |
| Hidden-API exemption only for framework Binder PoCs (Android harness) | avoid leaking framework setup into app PoCs |
| Compile/deploy only on explicit request | default is build-ready |
| Log a real proof signal, not a theory statement | usable validation |

Maintenance record (evidence, history, pattern pages): `wiki/` — read by the maintainer/proposer, never during execution.

## References

- `references/poc-spec.md`
- `references/index.md`
- `references/android-poc-base.md`
- `references/android-poc-*.md`
