---
name: decx-poc
description: Android exploit PoC construction skill. Turns one DECX proof-graph finding into one buildable PoC app, with optional compile and adb deployment when explicitly requested.
metadata:
  requires:
    bins: ["node", "decx"]
---

# DECX - Android Exploit PoC

Turn one finalized finding from the evidence graph into one buildable `poc-<target>` project.

## Routing Gate

Use only when the user asks to build or prepare a PoC from one DECX verified chain. Query the evidence graph with `node scripts/decx-analysis-db.mjs`. Do not use for vulnerability discovery, chain tracing, report generation, or generic exploit-writing advice. If no verified chain exists, route back to the relevant vulnhunt skill.

Default ceiling: `build-ready` unless the user explicitly asks for compile or deploy. Templates: `assets/poc-template-app/` and `assets/poc-template-server/`.

## Input: Read One Verified Chain

```bash
node scripts/decx-analysis-db.mjs chains <dir> --root-prefix entrypoint --leaf-prefix impact
node scripts/decx-analysis-db.mjs path <dir> --from <entrypoint_fact> --to <sink_fact>
node scripts/decx-analysis-db.mjs ancestors <dir> --fact <sink_fact>
```

Determine target kind from fact prefixes: `service-entrypoint` or `binder-reachability` → framework; otherwise app.

Fields needed: entrypoint + sink fact IDs, trigger details (from fact body/evidence), victim package/class or framework service name, component type or Binder interface, guard outcome facts, impact details, DECX port/session.

## Sink Re-Verification Protocol

Before writing any PoC code:

1. `path --from <entrypoint> --to <sink>` returns a connected chain
2. Entry fact prefix + body match the same entrypoint shape
3. Reachability fact body covers the shortest attacker action sequence
4. Sink fact body still names the same sink signature
5. Guard fact bodies show no missed non-bypassable guard
6. Impact fact body corresponds to a real observable effect
7. For framework: identity fact confirms caller identity at trust boundary

If any check fails: write a `dead-end` fact with the blocker reason, stop PoC construction. Do not write exploit code, create a project, compile, deploy, or state `runtime-validated` / `poc-validated`.

## Workflow

```text
- [ ] Read one verified chain (chains/path/ancestors)
- [ ] Run Sink Re-Verification Protocol
- [ ] Select trigger and requirements
- [ ] Create or reuse PoC project (setup-poc.mjs)
- [ ] Load one matching reference (references/index.md)
- [ ] Implement exploit
- [ ] Register exploit in ExploitRegistry
- [ ] Optional compile (explicit request only)
- [ ] Optional deploy and runtime check (explicit request only)
- [ ] Close DECX session
```

## Commands

```bash
# Proof graph queries
node scripts/decx-analysis-db.mjs chains <dir> --root-prefix entrypoint --leaf-prefix impact
node scripts/decx-analysis-db.mjs path <dir> --from <entrypoint_fact> --to <sink_fact>
node scripts/decx-analysis-db.mjs ancestors <dir> --fact <sink_fact>
node scripts/decx-analysis-db.mjs export <dir>

# DECX session
decx process open "<apk-path>" -P <port>
decx ard framework open "<jar>" --name "<target>" -P <port>
decx code method-source "<full-method-sig>" -P <port>
decx process close --port <port>

# PoC project
node skills/decx-poc/scripts/setup-poc.mjs <target-app>
node skills/decx-poc/scripts/check-env.mjs
cd poc-<target>/app && timeout 300 ./gradlew assembleDebug --no-daemon
```

## Rules

| Rule | Rationale |
|---|---|
| One active chain in context | prevents contamination |
| One `poc-<target>` per target, one exploit id per finding | reuse project, not exploits |
| `applicationId` under `com.poc.*`, `allowBackup="false"` | PoC hygiene |
| Replace every placeholder with verified target values | stale values = no-op exploit |
| Hidden-API exemption for framework Binder calls (`HiddenApiBypass.addHiddenApiExemptions("")`) | `ServiceManager`/`Stub.asInterface` need it; omitting → `NoSuchMethodException` at runtime |
| Framework findings use direct Binder calls, NOT `startActivity`/`bindService`/`sendBroadcast` | wrong delivery = PoC never reaches target |
| Close DECX session in the same response that completes the PoC | resource cleanup |
| Log a real proof signal, not a theory statement | "returned rows" not "exploit executed" |
| Two-stage exploits modeled as `capture → trigger` | explicit handle acquisition |

## References

- `references/index.md` — PoC shape routing matrix
- `references/poc-workflow.md` — output contract, compile/deploy
- `references/poc-base.md` — shared registration + success signal contract
- `references/poc-app-*.md`, `references/poc-framework-service.md` — per-surface code templates
