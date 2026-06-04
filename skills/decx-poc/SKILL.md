---
name: decx-poc
description: Android exploit PoC construction skill. Turns one DECX-supported finding into one buildable PoC app, with optional compile and adb deployment when explicitly requested.
metadata:
  requires:
    bins: ["node", "decx"]
---

# DECX - Android Exploit PoC

Turn one `decx-app-vulnhunt` or `decx-framework-vulnhunt` XML result into one buildable `poc-<target>` project.

## Routing Gate

Use only when the user asks to build or prepare a PoC from one DECX finalized `r_*.xml` result. Do not use for vulnerability discovery, chain tracing, report generation, DECX command help, or generic exploit-writing advice. If there is no selected `r_*.xml` result with `pocReady = true`, route back to `decx-app-vulnhunt` or `decx-framework-vulnhunt` instead of improvising a PoC.

Default ceiling: `build-ready` unless the user explicitly asks for compile or deploy. Project source comes from `assets/poc-template-app/` and `assets/poc-template-server/`.

## Hard Rules

- Keep exactly one active finding in context.
- Preferred source is `statically-supported`; `candidate` findings require explicit exploratory intent; `rejected` findings should not become PoCs.
- Source of truth is one finalized `r_*.xml` with `metadata.kind = result`; do not use a separate PoC handoff file.
- Do not use session handoff `h_<sessionName>.xml` as PoC source of truth.
- The selected XML must use current artifact identity: `sourceId`, `sinkId`, `flowSig`, and one selected `result` entry with `pocReady = true`.
- Re-verify the sink and PoC trigger through `decx-subagent` before coding. The main agent must not perform this verification itself.
- If subagent re-verification reports unreachable sink, non-bypassable guard, incomplete `poc` block, or XML/source mismatch, stop and do not generate PoC code.
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

- XML path: `.decx-analysis/<target>/r_<sourceId>_<sinkId>_<flowSig>.xml`
- `metadata.sourceId`, `metadata.sinkId`, `metadata.flowSig`, and `metadata.decxSession`
- victim package and class
- component type
- exact trigger shape: action, extras, URI, Binder method, deep link, or HTML payload
- source, sink, and minimal verified call chain
- exact bypass conditions
- visible success signal
- DECX port and session details
- XML `poc` block: trigger, steps, expected result, success signal, and requirements

Use `references/index.md` for reference selection and `references/poc-workflow.md` for the full output contract.

## Workflow

```text
PoC Progress
- [ ] Normalize one finding
- [ ] Delegate sink re-verification to decx-subagent
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

## References

- `references/index.md` -- reference routing matrix
- `references/poc-workflow.md` -- XML contract, compile/deploy, output format
- `references/poc-base.md` -- shared PoC contract and conventions
- `references/poc-app-*.md`, `references/poc-framework-service.md`
