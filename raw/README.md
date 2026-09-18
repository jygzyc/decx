# raw/ — immutable execution traces

This layer holds the raw execution records of DECX sessions: one note per
analysis/hunt trace with the target, the exact commands, observations, failures
and their fixes. Records are append-only — correct one by adding another, never
by rewriting it.

Records live in `raw/traces/<id>.md`; `decx_read` also accepts
`traces/<id>.md` as an alias for that path, mirroring the paper's read alias.

- Written by the `decx_trace` tool during or after a session. The wiki
  maintainer reads them; the inference agent does not, so no skill may require
  `raw/` to execute.
- **Gitignored by default** (`/raw/*`, with `!/raw/README.md`): traces are
  target data (target paths, device state, command output) and must not enter
  the repository by accident.
- A reviewed record may be **force-added** (`git add -f raw/traces/<file>.md`) when a
  proposal in `wiki/skill-impact.md` cites it as its evidence. The cited trace is
  then repository content and is reviewed like any other file.
- Never invent a trace: a pattern or skill change that cites a record must point
  at a real file under `raw/traces/`.
