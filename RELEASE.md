# DECX v4.0.1

DECX v4.0.1 is a patch release on top of v4.0.0: it adds the `decx self skills install` command, switches npm publishing to Trusted Publishing, and bumps a few dependencies.

### Changes

- CLI: new `decx self skills install --client <client>` command — downloads DECX skills from GitHub into `DECX_HOME/skills`, then symlinks them into private directories for Codex, Claude Code, and Cursor or the shared `~/.agents/skills` directory for every other or omitted client.
- CI: npm publishing now uses Trusted Publishing (OIDC) instead of the `NPM_TOKEN` secret — the `publish-npm` job runs on Node 24 (npm ≥ 11.5.1 required for Trusted Publishing) and relies on `id-token: write`; the `NPM_TOKEN` repository secret is no longer needed and can be deleted.
- Dependencies: logback 1.5.38 → 1.6.1, shadow 9.5.1 → 9.6.1, gradle/actions 6 → 6.2.0.
