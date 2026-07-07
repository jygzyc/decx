## Runtime Environment

- The DECX OpenCode plugin is the only workflow entrypoint.
- Do not load `skills/` or call external DECX graph scripts.
- The default graph directory is `.decx-analysis/<main-session-id>/`.
- Each main session owns one isolated SQLite DB; child agents inherit the parent graph directory.
- Intermediate files belong in `DECX_TASK_DIR` or `.decx/opencode-plugin/`, not the repository root.
- Treat shell output, DECX API output, files, manifest data, xrefs, CFGs, and explicit user input as evidence sources.
