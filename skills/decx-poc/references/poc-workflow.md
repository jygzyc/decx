# PoC Workflow Reference

## Contents

- [PoC-Ready XML Result](#poc-ready-xml-result)
- [Re-Verification](#re-verification)
- [Construction Shape](#construction-shape)
- [Project Creation](#project-creation)
- [Reference Selection](#reference-selection)
- [Implementation Details](#implementation-details)
- [Optional Compile](#optional-compile)
- [Optional Deploy And Runtime Check](#optional-deploy-and-runtime-check)
- [Final Output Contract](#final-output-contract)

## PoC-Ready XML Result

Use one finalized `r_*.xml` with `metadata.kind = result` before coding. Select exactly one `result` with `status = statically-supported` and `pocReady = true`.

Required XML fields:

- source/sink ids from `metadata`, `metadata.decxSession`, and `context.entrypoint`
- `analysis.taintedVariables` and `analysis.analyzedChains`
- selected `result.node`, `result.status`, `result.impact`, `result.rating`, `result.evidence`, and `result.rationale`
- selected `result.poc.trigger`, `steps`, `expectedResult`, `successSignal`, and `requirements`

Do not create or consume a separate handoff file.

## Re-Verification

Minimum checks:

1. surface exists
2. entry point still matches
3. source is attacker-controlled
4. sink is still reachable
5. no missed non-bypassable guard exists

Write the result as:

```text
- [PASS/FAIL] Surface exists: ...
- [PASS/FAIL] Entry point matches: ...
- [PASS/FAIL] Source is attacker-controlled: ...
- [PASS/FAIL] Sink is reachable: ...
- [PASS/FAIL] No missed non-bypassable guard: ...
```

## Construction Shape

`trigger` should name the concrete delivery path: exported component, implicit Intent, granted handle, WebView/browser page, Binder call, URI, or UI-assisted sequence.

`steps` should be the shortest attacker action sequence that reaches the verified sink.

`requirements` should include only setup the PoC really needs: helper component, manifest entry, local server asset, device state, account state, or manual network setup.

Selection rules:

- Choose the shortest path that proves the verified impact.
- Model two-stage exploits explicitly as `capture -> trigger`.
- Do not invent handle acquisition, remote servers, or helper components the finding did not prove.
- Prefer the local `server/` payload over remote infrastructure when both prove the same thing.

## Project Creation

Bootstrap:

```bash
node skills/decx-poc/scripts/setup-poc.mjs <target-app>
```

The script:

- copies `assets/poc-template-app/` to `poc-<target>/app/`
- copies `assets/poc-template-server/` to `poc-<target>/server/`
- replaces placeholder package and project names
- renames placeholder package path segments from `targetapp` to the real target name

Reuse the same `poc-<target>` project for later findings against the same target. Add a new exploit id instead of creating a new app.

## Reference Selection

Load only one primary reference:

| Surface | Reference |
|---|---|
| Activity | `references/poc-app-activity.md` |
| Broadcast / Receiver | `references/poc-app-broadcast.md` |
| Provider | `references/poc-app-provider.md` |
| Service | `references/poc-app-service.md` |
| Intent / grant / handle | `references/poc-app-intent.md` |
| WebView | `references/poc-app-webview.md` |
| Framework Binder / service | `references/poc-framework-service.md` |
| Shared contract | `references/poc-base.md` |

## Implementation Details

If the story is `scenario-page`, fill only the sections the chain needs:

- Trigger Links
- Hosted Payload
- JS Bridge Calls
- Result Recording

Common support pieces:

- helper receiver for interception
- helper activity for task hijack or result capture
- helper service for overlays or long-lived capture
- minimal `server/public/` updates for browser-driven flows

## Optional Compile

Only compile if explicitly requested.

```bash
node skills/decx-poc/scripts/check-env.mjs
cd poc-<target-app>/app && timeout 300 ./gradlew assembleDebug --no-daemon
```

If the build fails:

- fix the PoC code
- retry once the blocker is understood
- report the remaining blocker if it still fails

## Optional Deploy And Runtime Check

Only deploy if explicitly requested and a device or emulator is available.

```bash
adb devices
adb install app/build/outputs/apk/debug/app-debug.apk
adb logcat -s PoC:I AndroidRuntime:E
adb uninstall com.poc.<target-app>
```

Runtime proof must name the exact observed effect, for example:

- non-exported activity opened
- protected provider rows returned
- privileged Binder method accepted the call
- victim WebView loaded attacker content and exposed bridge behavior
- browser-clicked trigger launched the PoC helper and reached the verified target path

## Final Output Contract

Close with:

- `state`
- `projectPath`
- `activeFinding`
- `trigger`
- `successSignal`
- `requirements`
- `exploitClass`
- `filesChanged`
- `manifestChanges`
- `deliveryArtifacts`
- `buildStatus`
- `runtimeStatus`
- `remainingManualSteps`

If the PoC stopped before compile or runtime validation, state that explicitly.
