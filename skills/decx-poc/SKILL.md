---
name: decx-poc
description: Android exploit PoC construction skill. Turns one DECX blackboard finding into one buildable PoC app, with optional compile and adb deployment when explicitly requested.
metadata:
  requires:
    bins: ["node", "decx"]
---

# DECX - Android Exploit PoC

Turn one finalized finding from the SQLite blackboard into one buildable `poc-<target>` project.

## Routing Gate

Use only when the user asks to build or prepare a PoC from one DECX verified chain produced by either `decx-app-vulnhunt` (app targets) or `decx-framework-vulnhunt` (framework targets). Query the blackboard with `node scripts/decx-analysis-db.mjs`. Do not use for vulnerability discovery, chain tracing, report generation, DECX command help, or generic exploit-writing advice. If no verified chain exists, route back to the relevant vulnhunt skill (`decx-app-vulnhunt` for APK targets, `decx-framework-vulnhunt` for framework/Binder targets) instead of improvising a PoC.

Default ceiling: `build-ready` unless the user explicitly asks for compile or deploy. Project source comes from `assets/poc-template-app/` and `assets/poc-template-server/`.

## Hard Rules

- One active chain in context. Source of truth is the blackboard:
  ```bash
  node scripts/decx-analysis-db.mjs export <dir>
  ```
- Preferred status: `statically-supported`. `candidate` requires explicit exploratory intent; `rejected` is not PoC-able.
- Determine the target kind from fact descriptions before re-verification. If any fact starts with `service-entrypoint:` or `binder-reachability:`, the target is framework; otherwise app. Fact prefixes differ:
  - **App**: `entrypoint:`, `surface:`, `reachability:`, `control:`, `guard:`, `sink:`, `impact:`, `composition:`, `dead-end:`
  - **Framework**: `service-entrypoint:`, `binder-reachability:`, `identity:`, `permission-guard:`, `appop-guard:`, `user-guard:`, `identity-transition:`, `control:`, `sink:`, `impact:`, `composition:`, `dead-end:`
- Re-verify via the Sink Re-Verification Protocol before coding. On failure, stop and do not generate code.
- Every session-backed command must include `-P <port>`. If uncertain, run `--help` before retrying.
- Close the DECX session in the same final response that completes the PoC.
- Reuse one `poc-<target>` per target; one exploit id per finding.
- Keep `applicationId` under `com.poc.*`, `allowBackup="false"`. Hidden-API access only for framework paths that need it.

## Required Input

Read one verified chain before coding:

```bash
node scripts/decx-analysis-db.mjs export <dir>
```

Fields needed: entrypoint (app: `entrypoint:` fact; framework: `service-entrypoint:` fact) and sink fact IDs, trigger description (from fact evidence), victim package/class or framework service name, component type or Binder interface, fact chain sequence, guard outcome facts (app: `guard:`; framework: `permission-guard:` / `appop-guard:` / `user-guard:` / `identity:`), impact description (from fact evidence), DECX port/session. Target kind is inferred from fact prefixes (see Hard Rules).

Use `references/index.md` for reference selection and `references/poc-workflow.md` for the full output contract.

## Sink Re-Verification Protocol

Before writing any PoC code, perform these checks via the blackboard:

1. `path --from <entrypoint_fact> --to <sink_fact>` returns a connected chain.
2. Entry fact description maps to the same entrypoint/source shape (app: `entrypoint:` prefix; framework: `service-entrypoint:` prefix).
3. Reachability fact covers the shortest attacker action sequence to reach the verified sink (app: `reachability:`; framework: `binder-reachability:`).
4. Sink fact description still names the same `sink_signature`.
5. Guard fact descriptions show no missed non-bypassable guard (app: `guard:`; framework: `permission-guard:` / `appop-guard:` / `user-guard:` / `identity-transition:`).
6. Impact fact description corresponds to a real observable effect, not a theory statement.
7. For framework findings: identity evidence (`identity:` fact) confirms the caller identity assumption at the trust boundary.

If any check fails: record a blocker event, stop PoC construction. Do not write exploit code, create a PoC project, compile, deploy, or claim `runtime-validated` / `poc-validated`.

## Workflow

```text
PoC Progress
- [ ] Normalize one finding
- [ ] Run Sink Re-Verification Protocol
- [ ] Select trigger and requirements
- [ ] Create or reuse PoC project
- [ ] Load one matching reference
- [ ] Implement exploit
- [ ] Register exploit and wire support
- [ ] Optional compile
- [ ] Optional deploy and runtime check
- [ ] Close DECX session
```

## Core Commands

```bash
decx process open "<apk-path>" -P <port>
decx ard framework open "<final-framework-jar>" --name "<target-name>" -P <port>
decx ard exported-components -P <port>
decx ard app-manifest -P <port>
decx code method-source "<full-method-signature>" -P <port>
decx code class-source "<package.Class>" -P <port>
node scripts/decx-analysis-db.mjs export <dir>
node scripts/decx-analysis-db.mjs graph <dir>
node scripts/decx-analysis-db.mjs path <dir> --from <entrypoint_fact> --to <sink_fact>
node skills/decx-poc/scripts/setup-poc.mjs <target-app>
node skills/decx-poc/scripts/check-env.mjs
cd poc-<target-app>/app && timeout 300 ./gradlew assembleDebug --no-daemon
decx process close --port <port>
```

## Implementation Rules

- Place exploit code under `app/src/main/java/com/poc/<target-app>/exploit/`.
- Class name must reflect target plus vuln type.
- Replace every placeholder package, action, URI, extra key, and method name with verified target values.
- Keep helper logic local unless a Manifest component is actually required.
- Log a real proof signal, not a theory statement.
- For `deeplink`, `intent-url`, or `scenario-page`, keep `PoCActivity` route handling and `server/public/` artifacts aligned.
- Always register the exploit in `ExploitRegistry`.

## Gotchas

- **Building from `candidate` without explicit exploratory intent**: promote first via the vulnhunt skill, or confirm intent with the user.
- **Building from a `rejected` finding**: route back to the vulnhunt skill.
- **Skipping Sink Re-Verification**: bypasses the last guard against drift between the blackboard and current DECX source. Result: PoC targets an unreachable sink or non-bypassable guard.
- **Reusing one `poc-<target>` across multiple findings**: mixing exploits contaminates every PoC and breaks `ExploitRegistry`. One project per target, one exploit id per finding.
- **Hardcoding values from a stale record**: values must come from the current blackboard record and latest `decx code` query. Stale values produce no-op exploits.
- **Treating `poc_json.requirements` as advisory**: missing setup causes silent failure. Verify each requirement.
- **Improvising when no finalized finding with `poc_ready=true` exists**: route back to the vulnhunt skill.
- **Drifting `applicationId` or backup policy**: keep `applicationId` under `com.poc.*` and `allowBackup="false"`.
- **Leaving the DECX session open**: always close in the same final response that completes the PoC.
- **Reading success from logs only**: proof signal must map to `poc_json.successSignal` and a real observable effect from `impact`.
- **Mixing app and framework manifests**: framework PoCs need hidden-API access and possibly `INTERACT_ACROSS_USERS`; app PoCs do not. Wrong template strips required entries.
- **Missing hidden-API exemption for framework Binder calls**: framework PoCs calling `ServiceManager.getService()` or `Stub.asInterface()` must call `HiddenApiBypass.addHiddenApiExemptions("")` before any reflection. Omitting this produces `NoSuchMethodException` at runtime, not a compile error.
- **Assuming app-level intent delivery for framework findings**: framework Binder findings are triggered via direct Binder calls, not via `startActivity`/`bindService`/`sendBroadcast`. Using app-level delivery for a framework finding produces a PoC that never reaches the target service.
- **Ignoring identity/authorization facts in framework re-verification**: framework findings require identity evidence (`identity:` fact) at the Binder trust boundary. Skipping this check produces a PoC that assumes unprivileged access when the actual guard requires a specific UID or user handle.

## References

- `references/index.md` -- reference routing matrix
- `references/poc-workflow.md` -- output contract, compile/deploy, output format
- `references/poc-base.md` -- shared PoC contract and conventions
- `references/poc-app-*.md`, `references/poc-framework-service.md`
