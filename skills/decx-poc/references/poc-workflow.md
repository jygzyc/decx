---
name: poc-workflow
description: PoC XML contract, re-verification, compile/deploy, and final output format.
---

# PoC Workflow Reference

## PoC-Ready XML Result

Use one finalized `.decx-analysis/<target>/r_<sourceId>_<sinkId>_<flowSig>.xml` with `metadata.kind = result`. Select exactly one `result` with `status = statically-supported` and `pocReady = true`.

Required XML fields:

- `metadata.sourceId`, `metadata.sinkId`, `metadata.flowSig`, `metadata.decxSession`, `context.entrypoint`
- `analysis.taintedVariables`, `analysis.analyzedChains`
- selected `result.node`, `result.status`, `result.impact`, `result.rating`, `result.evidence`, `result.rationale`
- selected `result.poc.trigger`, `steps`, `expectedResult`, `successSignal`, `requirements`

Do not create or consume a separate handoff file. Do not use session handoff `h_<sessionName>.xml` as source of truth.

## Re-Verification

Mandatory and must be delegated to `decx-subagent`. The main workflow passes the XML path and selected result; the subagent checks sink and trigger conditions.

Minimum checks:

1. surface exists
2. entry point matches
3. source is attacker-controlled
4. sink is reachable
5. no missed non-bypassable guard
6. `poc.trigger`, `poc.steps`, `successSignal`, `requirements` are sufficient

Write as:

```text
- [PASS/FAIL] Surface exists: ...
- [PASS/FAIL] Entry point matches: ...
- [PASS/FAIL] Source is attacker-controlled: ...
- [PASS/FAIL] Sink is reachable: ...
- [PASS/FAIL] No missed non-bypassable guard: ...
- [PASS/FAIL] PoC trigger block is sufficient: ...
```

If any check fails, stop before project creation or code generation.

## Construction Selection

- `trigger`: concrete delivery path (exported component, Intent, Binder, WebView, URI, UI-assisted sequence)
- `steps`: shortest attacker action sequence reaching the verified sink
- `requirements`: only what the PoC really needs (helper component, manifest entry, server asset, device state)

Rules:

- Choose the shortest path that proves the verified impact.
- Model two-stage exploits as `capture -> trigger`.
- Do not invent handle acquisition, remote servers, or helpers the finding did not prove.
- Prefer local `server/` payload over remote infrastructure.

## Project Creation

```bash
node skills/decx-poc/scripts/setup-poc.mjs <target-app>
```

Copies `assets/poc-template-app/` to `poc-<target>/app/` and `assets/poc-template-server/` to `poc-<target>/server/`, replaces placeholders, renames package path segments. Reuse the same project for later findings against the same target.

## Optional Compile

Only when explicitly requested.

```bash
node skills/decx-poc/scripts/check-env.mjs
cd poc-<target-app>/app && timeout 300 ./gradlew assembleDebug --no-daemon
```

## Optional Deploy And Runtime Check

Only when explicitly requested and a device/emulator is available.

```bash
adb devices
adb install app/build/outputs/apk/debug/app-debug.apk
adb logcat -s PoC:I AndroidRuntime:E
adb uninstall com.poc.<target-app>
```

Runtime proof must name the exact observed effect: non-exported activity opened, protected provider rows returned, privileged Binder method accepted, victim WebView loaded attacker content, etc.

## Final Output Contract

Close with: `state`, `projectPath`, `activeFinding`, `sourceId`, `sinkId`, `flowSig`, `trigger`, `successSignal`, `requirements`, `exploitClass`, `filesChanged`, `manifestChanges`, `deliveryArtifacts`, `buildStatus`, `runtimeStatus`, `remainingManualSteps`.

State that explicitly if stopped before compile or runtime validation.
