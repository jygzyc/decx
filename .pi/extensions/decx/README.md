# Decx WikiSkill extension

Implements the three-layer workflow from [WikiSkill §3](https://arxiv.org/html/2608.27454):
execution → immutable trace → consolidated pattern → one skill-file candidate →
validation → accept or restore. This is a maintenance extension, not a benchmark
runner. Scores and evaluation records must come from actual external evaluations;
structural checks never count as performance measurements.

## Update the wiki with one command

Start a new pi session in the project and run:

```text
/decx-wiki
```

The command enters maintenance mode and starts the agent automatically. It discovers
configured workspaces and trace/page paths from disk, asks the maintainer to inspect
the evidence and existing wiki, consolidate new findings, synchronize the index and
run the structural check. The final response summarizes the changes in English.
No manual phase selection or tool-by-tool instructions are needed.

`/decx-wiki decx` restricts the pass to one configured workspace; without an argument
it processes all configured workspaces. Repeated runs compare the traces with the
existing patterns rather than blindly appending them. There is no consumed-trace
cursor: the maintainer reviews the available evidence each time. With no new evidence
it reports that fact and checks structure without inventing new patterns. The command
starts an agent task, so it needs the normal model connection and is not a deterministic
offline compiler. It does not modify skills or run their evaluations.

## Run the loop

1. Start an **inference** session (the default). Use the skills to run the task.
   `decx_trace` records exact commands, observations and outcomes under `raw/traces/`.
   It does not create or update wiki files. Record failed runs too.
2. Start a separate session and run `/decx-wiki`. The agent reads traces and
   patterns, consolidates findings and checks the wiki automatically. The advanced
   `/decx phase maintain` and individual tools remain available for targeted work.
   Authored bootstrap knowledge is not rollout evidence.
3. Measure the current skill on a fixed validation split in a separate inference
   session. Record the task IDs, dataset revision, scoring procedure and results
   with `decx_trace`.
4. In the maintenance session select `/decx phase propose`. Call `decx_propose`:

   ```json
   {
     "workspace": "decx",
     "target": "skills/decx-tool/SKILL.md",
     "content": "<complete candidate file content>",
     "change": "<one atomic change and why>",
     "pattern": "wiki/patterns/<slug>.md",
     "split": "<dataset revision and fixed validation task IDs>",
     "baseline": 0.5,
     "baselineTrace": "raw/traces/<baseline-id>.md"
   }
   ```

   The target must already exist. Only one candidate may be pending per workspace.
   The extension saves the original file and applies the candidate; direct skill
   editing is not part of this workflow. Scores above are illustrative only.
5. Evaluate the candidate in another fresh inference session on the **same split**.
   Record a separate evaluation trace. Then return to the proposer and call
   `decx_gate` with `workspace`, `split`, numeric `candidate`, `candidateTrace` and
   `outcome`. Acceptance requires `candidate > baseline`. Ties and regressions
   restore the original skill. To cancel without a measurement, use
   `reject: true` and an honest `outcome`.
6. Run `decx_check` and review the candidate diff and evidence. Raw records, patterns
   and the proposal ledger persist after rejection. Candidate snapshots, gate
   inputs and outcomes are archived under `<pi agent dir>/decx/sessions/`.

A session that entered maintenance cannot return to inference: wiki content is
already in its context. The phase is recorded in pi session entries and restored
when the session resumes. Start a new session to evaluate skills independently.
Do not run unrelated analysis against a workspace while a candidate is applied.

## Access contract

| Surface | Inference | Maintain | Propose |
| --- | --- | --- | --- |
| Native read/search | Skills and task files; no raw/wiki/PURPOSE | Blocked | Blocked |
| Native edit/write | Task files; no knowledge-layer edits | Blocked | Blocked |
| `decx_trace` | Exclusive creation in raw | Blocked | Blocked |
| `decx_read` | Blocked | Wiki, traces, skill resources | Same |
| `decx_maintain` | Blocked | Pattern patches and matching index | Blocked |
| `decx_propose`, `decx_gate` | Blocked | Blocked | Candidate application and gate |
| `decx_check` | Blocked | Structural checks | Structural checks |
| `decx_checkpoint` | Session state | Session state | Session state |

Managed API paths reject traversal, symlinks and hard links. `decx_read` has an
explicit page allowlist, not a general workspace-file fallback. Raw writes use
exclusive creation and never overwrite an existing trace. Maintenance patches are
validated together in memory before file writes begin; validation errors leave
pages unchanged. This is not a crash-atomic multi-file transaction: disk failures
can interrupt a commit. Repair the affected pages and run CLI `resync`/`check`.

Mutations share a workspace lock (`.pi/decx-write.lock`) across cooperating sessions
and the CLI, plus pi's file mutation queue. A competing operation fails with
`WORKSPACE_BUSY` instead of losing updates. After a process crash, verify no writer
is active before removing the stale lock directory. Individual replacement writes use a temporary file and rename. Recovery data precedes skill
application; use `decx_gate` with `reject: true` to recover an interrupted proposal.
A durable gate decision is completed unchanged on retry after an interrupted write.
External skill edits are detected and never silently overwritten by rollback.

These are **tool/API restrictions, not an OS filesystem sandbox**. Inference still
needs shell commands to run native analyzers. Explicit raw/wiki shell references
are blocked, but dynamically constructed paths, arbitrary programs, custom tools,
user shell commands and external processes can bypass these checks. Maintenance
blocks general tools entirely. Strong isolation requires an external sandbox with
only skill/task files mounted; this extension does not claim that protection.
The gate verifies numeric range, split identity and separate existing trace paths;
it does not independently verify the truth of submitted scores or trace contents.

## Verification

```sh
node --test .pi/extensions/decx/lib.test.ts
node .pi/extensions/decx/cli.ts check
python3 skills/check-skills.py
```

Tests cover access phases, traversal/link aliases, concurrent trace creation,
failed-patch isolation, same-split gating, rollback and conflict detection. Tests
use temporary workspaces, not the user's real knowledge base or agent state.
