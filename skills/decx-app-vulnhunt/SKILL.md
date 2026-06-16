---
name: decx-app-vulnhunt
description: APK app-layer vulnerability hunting with DECX. Use when analyzing exported components, deep links, WebView/Provider/Service/Receiver IPC paths, app attack surfaces, or composed APK exploit chains.
metadata:
  requires:
    bins: ["decx"]
---

# DECX App Vulnerability Hunting

**Goal: discover exploitable vulnerability chains in the target APK to enable timely remediation and reduce business security risk.** Identify proven, exploitable paths from attacker entrypoint to visible impact, validated through the evidence gate. Every intent created should serve this goal.

Evidence graph: observations as facts, relations as edges, investigation steps as intents.

Route elsewhere: `decx-framework-vulnhunt` (framework/Binder), `decx-cli` (command help), `decx-report` (reports), `decx-poc` (PoC).

## Main Agent: Delegate and Decide

Main agent does **only** these, nothing else:
1. `init` project + `decx process open` session
2. Delegate intent goals to subagent (one goal per delegation)
3. Read subagent summary + run `chains` to verify evidence paths
4. Decide promotion against `references/risk-rating.md`
5. Handoff to report/poc

Main agent must NOT run `decx code`, `decx ard`, read source code, load references, or analyze vulnerability patterns. All analysis happens in subagent.

## Subagent: Owns Full Intent Lifecycle

Subagent receives: intent goal text + DB dir + DECX port. It owns the full lifecycle:
1. Create the intent via `intent` CLI (knows phase, references facts it discovers)
2. Run `decx code`/`decx ard` queries (must view code via DECX commands — never guess)
3. Load `references/index.md` for routing, `references/patterns/*.md` for trace cues
4. Write `fact`/`edge` directly to DB
5. Call `solve --conclude <factId>` or `--fail` when done
6. Return a structured JSON summary (contract below)

Subagent creates the intent itself (not main agent), so it always knows the correct `--from` fact IDs — no mismatch errors.

### Subagent Summary Contract

After `solve`, subagent returns this JSON as its final output:

```json
{
  "intent_id": "i003",
  "status": "done",
  "phase": "trace",
  "goal": "Trace url extra to sink",
  "facts": {
    "total": 5,
    "types": { "entrypoint": 1, "reachability": 1, "control": 1, "guard": 1, "sink": 1 },
    "key_fact_ids": ["f004", "f008"]
  },
  "has_proving_path": true,
  "result_fact": "f008"
}
```

**DB is always source of truth.** Summary is a routing aid — main agent uses it to decide next intents. Before promotion, main agent still verifies graph structure with `chains`.

Do not specify subagent type when delegating — just give the task goal + DB dir + DECX port.

## Commands

```bash
# Main agent
node scripts/decx-analysis-db.mjs init   <dir> --session <name> --kind android_app
node scripts/decx-analysis-db.mjs intents <dir> [--status <open|done|failed>]
node scripts/decx-analysis-db.mjs facts   <dir> [--prefix <type>]
node scripts/decx-analysis-db.mjs chains  <dir> [--root-prefix <type>] [--leaf-prefix <type>]
node scripts/decx-analysis-db.mjs export  <dir>

# Subagent
node scripts/decx-analysis-db.mjs intent  <dir> [--from <factId,...>] --goal "<question>" [--priority <n>] [--phase <stage>]
node scripts/decx-analysis-db.mjs fact    <dir> --prefix <type> --body "<text>" [--evidence <path>] [--confidence <0-1>]
node scripts/decx-analysis-db.mjs edge    <dir> --from <factId> --to <factId> --kind <proves|enable|carry|amplify|bypass|observe>
node scripts/decx-analysis-db.mjs solve   <dir> <intentId> --conclude <factId> | --fail "<reason>"
node scripts/decx-analysis-db.mjs chains  <dir> [--root-prefix <type>] [--leaf-prefix <type>]
node scripts/decx-analysis-db.mjs path    <dir> --from <id> --to <id>
node scripts/decx-analysis-db.mjs ancestors  <dir> --fact <id>
node scripts/decx-analysis-db.mjs descendants <dir> --fact <id>
```

## Dispatch Protocol

Main agent follows this exact loop, nothing more:

```
1. init + decx process open
2. Delegate to subagent: goal="Collect attack surface: exported components, deep links, AIDL, dynamic receivers", phase=surface
   Subagent: intent → analyze → write facts → solve → return summary
3. For each entrypoint fact in summary: delegate to subagent goal="Trace <factId> to sink, prove 5-tuple", phase=trace
   Subagent: intent --from <factId> → analyze → write facts → solve → return summary
4. For each promoted pair: delegate to subagent goal="Validate composition edge <f1,f2>", phase=compose
   Subagent: intent --from <f1,f2> → analyze → write facts → solve → return summary
5. Check chains, promote against risk-rating.md, handoff
```

One intent = one subagent invocation. Do not batch multiple intents in one delegation.

## Evidence Gate

Promote only when ALL five fact types exist, connected by `proves` edges:

| Type | What it proves |
|---|---|
| `entrypoint` | exported component, trigger syntax |
| `reachability` | attacker can trigger the path |
| `control` | attacker-controlled field reaches sink argument |
| `guard` | guard returns pass, bypassed, or absent |
| `sink` + `impact` | dangerous operation + visible consequence |

## Composition Edges

| Edge | Meaning |
|---|---|
| `enable` | A creates access needed by B |
| `carry` | A transports data to B |
| `amplify` | A increases B's impact |
| `bypass` | A defeats B's guard |
| `observe` | A makes B's impact visible |

## Rules

| Rule | Why |
|---|---|
| Main agent never runs `decx code`/`decx ard` or reads source | main agent context stays clean |
| Subagent owns full intent lifecycle (create → analyze → solve → summarize) | subagent knows fact IDs, avoids `--from` mismatch |
| Subagent views code via `decx code`/`decx ard` commands only — never guesses | guessing produces hallucinated evidence |
| Subagent returns structured JSON summary after `solve` | main agent gets concise view without extra DB reads |
| DB is source of truth; verify with `chains` before promotion | summary is routing aid, not proof of evidence gate |
| One intent per subagent invocation | prevents context explosion |
| `evidence` must be file path | prevents token blowup |
| Method names are not evidence | `validate*`/`check*` names mislead |
| Composition must be validated by dedicated subagent | adjacency ≠ composition |
| Cannot state `poc-validated` / `runtime-validated` | static analysis limit |
| Handoff at 60% context: `export` + session name | prevents truncation |
| Full method signatures: `"pkg.Class.method(param):return"` | precise identification |

## References

- `references/index.md` — routing matrix (subagent loads this)
- `references/risk-rating.md` — severity levels (main agent loads before promotion)
- `references/patterns/*.md` — vulnerability shapes (subagent loads on signal)
