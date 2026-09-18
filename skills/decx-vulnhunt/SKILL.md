---
name: decx-vulnhunt
description: Vulnerability hunting with DECX across target kinds. Use when analyzing APK app-layer attack surfaces (exported components, deep links, WebView/Provider/Service/Receiver IPC), Android framework/Binder targets (system_server, AIDL, system services, vendor/OEM code, privileged IPC), or native binaries and ET_REL objects (exported/JNI symbols, ioctl handlers, vendor kernel modules), including composed exploit chains.
---

# DECX Vulnerability Hunting

Goal: prove exploitable attack paths from entrypoint to visible impact on one supported target kind — Android app-layer, Android framework/Binder, or a native binary.

## Routing Gate

Use for vulnerability hunting on any supported target (Android app, Android framework/Binder, native binary). Do not use for report writing, PoC construction, or tool command syntax.

Route reports to `decx-report`, PoC work to `decx-poc`, tool syntax to the tool's own skill (`decx-droidasc`, `decx-kuna`, `decx-afe`), environment and install work to `decx-init`, and leave session bookkeeping to the `decx_*` tools.

## Targets

Pick exactly one track per target: the track fixes the tool entry, the surface and the chains file.

| Track | Artifact | Tool entry | Surface |
|---|---|---|---|
| `android-app` | APK / JAR with DEX code | `droidasc getclass` / `droidasc findrefs` (stateless; no open step) | exported components, deep links, AIDL, dynamic receivers, WebView, providers, services |
| `android-framework` | framework artifact | `afe` collects/preprocesses, then `droidasc getclass` / `droidasc findrefs` on the packed jar; `kuna` for native libraries in the artifact | Binder services, AIDL methods, system service implementations |
| `native` | native binary or `.ko` ET_REL object | `kuna functions` / `kuna decompile` / `kuna xrefs` / `kuna strings` (stateless) | exported and JNI symbols, ioctl and file-operation dispatch, module parameters, unpacking |

Load `references/<track>-chains.md` for composite chains and single-pattern routing (`android-app-chains.md`, `android-framework-chains.md`, `native-chains.md`).

References are a vulnerability knowledge base, not a workflow manual — this file controls execution. Every pattern card carries YAML frontmatter `track: <platform>[-<component>]` (`android-app`, `android-framework`, `native`, …); only load cards matching the active track. A card should add one of: a routing signal, a non-obvious API/Binder/identity/permission quirk or version default, or a closed-form constraint that prevents false positives. Stop reading a card when it only repeats generic Android security knowledge.

## Analysis Workflow

1. Confirm the target artifact for the track (stateless tools — pass the path on every command).
2. Collect the track's attack surface.
3. Match observed code to the track's chain pivots and pick the smallest chain that matches. Load one or two matching `references/patterns/<track>-*.md` cards for source/sink/guard/reject rules; do not load sibling cards by name alone — only when the trace crosses that boundary.
4. Trace entry → control → guard → sink → impact with the track's tool (`droidasc` on APK/JAR and on the packed framework jar, `kuna` on native binaries and ET_REL objects; exact syntax in `decx-droidasc` / `decx-kuna` / `decx-afe`). Record concrete evidence per step (class/method/line or symbol/section offset, trigger syntax, reachable sink).
5. Apply `references/risk-rating.md` before calling any candidate a finding.
6. Write one finding writeup per proven path (see Finding Writeup).

Use human hints when provided, but never promote a path without complete evidence.

## Evidence Gates

Call it a finding only when concrete evidence proves every required kind along one traced path. Each track names its own kinds; every kind must be backed by a concrete artifact, never by a name or a registration.

### App track (`android-app`)

| Kind | Required proof |
|---|---|
| `entrypoint` | component type, exported/trigger condition, trigger syntax |
| `reachability` | attacker action reaches the path |
| `control` | attacker-controlled value reaches sink argument |
| `guard` | guard passes, is bypassed, or is absent |
| `sink` | dangerous operation |
| `impact` | visible consequence |

### Framework track (`android-framework`)

| Kind | Required proof |
|---|---|
| `service-entrypoint` | Binder/service method exposed |
| `binder-reachability` | unprivileged caller can reach it |
| `control` | attacker-controlled Binder parameter/state reaches sink |
| `identity` | caller identity at trust boundary |
| `permission-guard` / `appop-guard` / `user-guard` | authorization result |
| `sink` | privileged operation |
| `impact` | system-visible consequence |

Framework guards must be checked at the Binder trust boundary (caller identity bound before the privileged operation, target user bound via `INTERACT_ACROSS_USERS` before any `asUser` call).

### Native track (`native`)

| Kind | Required proof |
|---|---|
| `entrypoint` | exported symbol, JNI callback, ioctl or file-operation handler, with object and section offset |
| `caller-reachability` | the calling context is one an attacker controls (unprivileged app, socket peer, device-node access) |
| `control` | attacker-controlled buffer or value reaches the sink argument |
| `guard` | SELinux domain, capability, signature or bounds check passes, is bypassed, or is absent |
| `sink` | privileged memory/IO or kernel operation |
| `impact` | device-visible consequence (privilege, data, code execution) |

Native evidence lives in the object: a decompiled function plus the call path to the entrypoint. A module's `init_module` is not an entrypoint — start from the dispatch a caller can reach.

For every track, reject candidates based only on names/registration, inline-only evidence, mixed evidence kinds, or scope drift.

## Process Discipline

The failure modes below cost more than a missing API detail; check them before promoting
anything.

- **Order by cost to redo.** An intake mistake invalidates everything downstream, so
  enumerate the surface before collecting evidence and trace the chain before rating it.
  A skipped stage leaves no artefact — re-entering a stage is normal, skipping it silently
  is not.
- **Routing versus claim.** "Look at this component" needs no proof; "this path is
  exploitable" needs the full chain. Label a hypothesis as one, so it stays usable while
  the chain is built.
- **A second source of truth.** Re-reading the output that produced the claim repeats the
  same interpretation: verify against another analyzer, a clean state or a runtime
  observation, and run the card's Reject test to falsify the claim cheaply.
- **Artefact identity.** Record what produced a trace (path, version, checksum, device
  build). After a resume, re-extraction or re-install, re-check those identities before
  continuing; a trace without identity is a method, never proof.
- **One view is not both views.** Packaged code, native libraries and image-derived
  artefacts are different layers: "not found" is a statement about the query, not about
  the artefact, so record the query with the empty result. Cross-check at the entrypoint,
  where it is cheap, not at the sink.
- **Scope.** Keep the checkpoint's goal line current; a widened scope changes the exit
  gate, not only the work. Park a lead as a checkpoint step instead of following it
  silently.
- **Handoff.** One writeup per proven path, field names from this file, and the traces it
  cites must be findable again; an incomplete chain is still worth handing over when the
  unproven links are named.

## Finding Writeup

One proven path = one finding writeup. Field contract (one field per line):

- `id` — `F<n>`, numbered in analysis order; reused directly as report anchor and PoC spec id
- `title`
- `target` — analyzed artifact path with its track (APK/JAR; the collected and packed framework output; a native binary or `.ko` object)
- `entrypoint` — the reachable entry with its exported/trigger condition (component/service, Binder method, exported symbol, ioctl)
- `trigger` — concrete trigger syntax
- `path` — entry → control → guard → sink, with concrete evidence per step (class/method/line level)
- `impact` — visible consequence
- `rating` — per `references/risk-rating.md` + rationale
- `evidence` — tool command outputs / code location references

`decx-report` and `decx-poc` consume this contract; field names in this section are the single source of truth.

Hand finalized finding writeups to `decx-report` for reporting and `decx-poc` for PoC construction.

## After a Hunt

Evidence, history and the pattern pages behind these rules live in the repository wiki (`wiki/`, catalog `wiki/index.md`); the maintainer reads it after a hunt, execution never does.

A finished hunt is consolidated through the extension's maintenance tools: record the run with `decx_trace`, fold it into `wiki/patterns/` with `decx_maintain` (it writes pattern pages and the index — the log and the ledger stay seeded), then propose one gated `SKILL.md` change with `decx_propose`. Never edit the wiki by hand, and never treat a wiki page as authority — the `SKILL.md` above and the `references/` cards below are the execution contract.

## References

- `references/android-app-chains.md` — `android-app` composite chains and single-pattern routing
- `references/android-framework-chains.md` — `android-framework` composite chains and single-pattern routing
- `references/native-chains.md` — `native` routing (bootstrap: one card)
- `references/patterns/<track>-*.md` — pattern cards; load only the ones matching the active track
- `references/risk-rating.md` — single rating authority for every track; load only before calling a candidate a finding
- `wiki/` — maintenance record (traces, logs, pattern history); not read during execution
