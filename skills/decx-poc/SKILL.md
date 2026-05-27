---
name: decx-poc
description: Android exploit PoC construction skill. Turns one DECX-supported finding into one buildable PoC app, with optional compile and adb deployment when explicitly requested.
metadata:
  requires:
    bins: ["node", "decx"]
---

# DECX CLI - Android Exploit PoC

Turn one `decx-app-vulnhunt` or `decx-framework-vulnhunt` XML result into one buildable `poc-<target>` project.

Project shape:

- Android side: minimal app template with `ExploitEntry`, `ExploitRegistry`, and `PoCActivity`
- Web side: local `server/` with `index.html`, `scenario.js`, and `server.mjs`
- Bootstrap path: copy templates, replace placeholders, rename package path segments

Default ceiling:

- Stop at `build-ready` unless the user explicitly asks for compile.
- Do not claim `deployed` or `runtime-validated` unless deployment or runtime proof actually happened.

## Hard Rules

- Keep exactly one active finding in context.
- Preferred source is `statically-supported`; `candidate` findings require explicit exploratory intent; `rejected` findings should not become PoCs.
- Source of truth is one finalized `r_*.xml` with `metadata.kind = result`; do not use a separate PoC handoff file.
- Re-verify the finding in DECX before coding.
- Every session-backed `decx code` and `decx ard` command must include `-P <port>`.
- If a command is missing, rejected, or uncertain, run the nearest `--help` command before retrying.
- Before final response, close any DECX session used for PoC work with `decx process close <session-name>` or `decx process close --port <port>`.
- Reuse one `poc-<target>` project per target; add one exploit id per finding.
- Add only the Manifest entries, helper components, permissions, and server assets required for the active exploit.
- Keep `applicationId` under `com.poc.*` and keep `allowBackup="false"`.
- Use hidden-API access only for framework Binder paths that actually need it.
- If re-verification contradicts the report, stop and report the mismatch.

## Required Input

Read one XML `result` with `pocReady = true` before coding:

- victim package and class
- component type
- exact trigger shape: action, extras, URI, Binder method, deep link, or HTML payload
- source, sink, and minimal verified call chain
- exact bypass conditions
- visible success signal
- DECX port and session details
- XML `poc` block: trigger, steps, expected result, success signal, and requirements

Select construction details up front:

- `trigger`: exact Activity, Service, Receiver, Provider, URI, Intent, Binder, WebView, or browser path
- `steps`: shortest attacker action sequence that reaches the verified sink
- `requirements`: required helper component, manifest entry, local server asset, device state, or manual setup

Use `references/poc-workflow.md` for the PoC-ready XML result, construction selection rules, compile/deploy commands, and final output contract.

## Workflow

```text
PoC Progress
- [ ] Normalize one finding
- [ ] Re-verify target path in DECX
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

If the DECX session is not open, ask the user to open it:

```bash
decx process open "<apk-path>" -P <port>
```

Minimum re-verification:

```bash
decx ard exported-components -P <port>
decx ard app-manifest -P <port>
decx code method-source "<full-method-signature>" -P <port>
decx code class-source "<package.Class>" -P <port>
```

Bootstrap:

```bash
node skills/decx-poc/scripts/setup-poc.mjs <target-app>
```

Optional compile only when explicitly requested:

```bash
node skills/decx-poc/scripts/check-env.mjs
cd poc-<target-app>/app && timeout 300 ./gradlew assembleDebug --no-daemon
```

Close the DECX session used for re-verification:

```bash
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

## References

- `references/poc-workflow.md`
- `references/poc-base.md`
- `references/poc-app-activity.md`
- `references/poc-app-broadcast.md`
- `references/poc-app-provider.md`
- `references/poc-app-service.md`
- `references/poc-app-intent.md`
- `references/poc-app-webview.md`
- `references/poc-framework-service.md`
