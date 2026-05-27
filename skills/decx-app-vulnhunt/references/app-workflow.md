# App VulnHunt Workflow

Use this file for the step-by-step APK analysis loop. Keep `SKILL.md` as the controller and write durable state under `.decx-analysis/<target-name>/`.

## Phase 1 - Prepare Target

Goal: bind analysis to one APK session and named XML artifacts.

```bash
decx process list
decx process open "<apk-path>" --name "<target-name>" -P <port>
decx process status "<target-name>" -P <port>
```

Create XML artifacts from `assets/decx-analysis-template.xml`.

Artifact names:

- intermediate analysis: `.decx-analysis/<target-name>/h_<sourceId>_<sinkId>_<flowSig>.xml` with `metadata.kind = handoff`
- finalized result: `.decx-analysis/<target-name>/r_<sourceId>_<sinkId>_<flowSig>.xml` with `metadata.kind = result`

Meaning:

- `sourceId` is the stable id assigned to the analysis-chain source.
- `sinkId` is the stable id assigned to the current known or suspected sink.
- `flowSig` is the current analyzed class-level signature; the file name uses a sanitized form, while XML keeps the original signature.
- If one class contains multiple issues, write multiple `result` entries in the same artifact instead of creating duplicate class-level artifacts.
- One source chain can create multiple intermediate `h_...xml` files as the trace crosses class-level flow signatures or discovers different sinks.
- Do not add sequence fields for ordering. Use existing `analysis.depth`, `analyzedChains`, `beforeHop`, and `nextHop` to express progress.

Use `node skills/decx-app-vulnhunt/assets/decx-artifact.mjs <target-dir> <source-sig> <sink-sig> <flow-sig> <session> <kind>` to create artifacts. The script computes `sourceId` and `sinkId` as base64url of the source/sink component signatures and sanitizes `flowSig` only for the file name. Treat old `decx-analysis.xml` and old recon/coverage/findings/resume JSON files as stale workflow artifacts.

## Phase 2 - Enumerate Surface

Goal: create a complete candidate map before deep tracing.

```bash
decx ard app-manifest -P <port>
decx ard exported-components -P <port>
decx ard app-deeplinks -P <port>
decx ard app-receivers -P <port>
decx ard get-aidl -P <port>
decx ard all-resources -P <port>
```

Record stable source signatures for exported Activities, Services, Receivers, Providers, deep links, dynamic receivers, WebView hosts, AIDL/Binder surfaces, URI grants, PendingIntent creators/consumers, and provider authorities. Record a sink signature when a sink, blocker, dead end, or concrete target boundary is identified.

## Phase 3 - Permission And Reachability Inventory

Goal: avoid false rejection from incomplete access-control context.

Record:

- declared `<permission>` and its `protectionLevel`
- `<uses-permission>`
- component `android:permission`
- provider `readPermission` and `writePermission`
- receiver sender/receiver permission arguments
- grant flags, FileProvider roots, and URI grant paths

Do not drop `signature` or `signatureOrSystem` paths until caller ownership, proxying, forwarding, victim identity reuse, re-grants, and weaker alternate paths are resolved.

## Phase 4 - Route Knowledge

Goal: load only the knowledge needed for the current target.

1. Start with `references/index.md`.
2. Use `references/vulnerability-router.md` to select the smallest matching knowledge set.
3. Load one `references/overviews/*.md` component map when component context matters.
4. Load one or two `references/patterns/*.md` cards.
5. Load `references/casebooks/*.md` only for comparable exploit-chain shapes.
6. Use `references/risk-rating.md` only after tracing reaches sink, blocker, or missing proof.

## Phase 5 - First Pass

Goal: classify every target without silently losing reachable surface.

Allowed states:

- `candidate`: suspicious path exists but proof is incomplete
- `statically-supported`: reachability, controllability, guard bypass, impact, and evidence are present
- `rejected`: unreachable, uncontrollable, blocked by non-bypassable guard, or not impactful

Every rejection needs explicit blocker evidence.

### Rejection Shortcuts

- Exported or reachable alone is not a finding.
- Platform-version trivia is not evidence.
- A vulnerable-looking API call is not a finding unless attacker-controlled data reaches it.
- A custom permission is not bypassable until ownership and `protectionLevel` are known.
- A WebView setting is not reportable unless attacker-controlled content reaches the WebView.
- UI deception findings stay low or rejected unless a protected action is actually approved.

## Phase 6 - Deep Trace

Goal: prove one chain at a time.

Subagent rule:

- Deep trace must be delegated to `decx-subagent-analysis`.
- The main agent must not deep-trace the chain itself.
- Before dispatch, create or update `.decx-analysis/<target-name>/h_<sourceId>_<sinkId>_<flowSig>.xml` with `decx-artifact.mjs`.
- The XML is the context packet: it must contain `sourceId`, `sinkId`, `flowSig`, session, entrypoint, tainted variables, analyzed calls, current result, `nextHop`, and stop condition.
- Pass only that XML path plus the assigned chain to the subagent.
- If the subagent cannot be invoked, stop the deep trace and record the blocker in the XML.

For each chain, record:

- `sourceId`
- `sinkId`
- `flowSig`
- entrypoint and attacker-controlled source
- current method/class and analyzed calls
- `nextHop`
- guard branches and blocker evidence
- sink and visible impact

Save this chain in `h_<sourceId>_<sinkId>_<flowSig>.xml`. Use one active intermediate artifact per source/sink/class-level flow tuple. If the same source chain moves into another class or discovers a different sink, create another `h_...xml` with the same `sourceId` and the new `sinkId` or `flowSig`.

Trace through helpers, callbacks, IPC, WebView navigation, providers, URI grants, `setResult`, PendingIntent execution, nested components, async handlers, and Binder boundaries. Stop only at a sink, a non-bypassable guard, a dead end, or named missing proof.

### Deep-Trace Rules

- When a method forwards `Intent`, `Bundle`, `Uri`, `ClipData`, `PendingIntent`, `Message`, `Parcel`, WebView URL/HTML/JS, provider args, or file paths, trace the receiver side before judging.
- When a helper sanitizes or validates, open the helper and prove the exact branch outcome; do not infer from method names.
- When a target returns data or grants, trace the caller-visible result path as part of impact.
- When a sink is wrapped by async work, handler dispatch, coroutine, callback, or listener, follow the scheduled method.

## Phase 7 - Finalize

Goal: promote only evidence-backed findings.

A final finding must answer:

- reachable
- controllable
- bypass conditions or guard result
- impact evidence
- rating rationale
- report-ready evidence

If any answer is missing, keep the intermediate artifact as `candidate` or `rejected`.

## Phase 8 - Report Or PoC Handoff

Write each promoted finding to `r_<sourceId>_<sinkId>_<flowSig>.xml` with `metadata.kind = result` and hand finalized result XML to `decx-report`. For PoC handoff, fill exactly one selected result's XML `poc` block and mark it `pocReady`; do not create a separate PoC handoff file.
