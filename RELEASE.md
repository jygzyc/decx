# DECX v4.1.1

DECX v4.1.1 fixes `decx self install` / `self update` for users hitting GitHub API rate limits and hardens the update path.

### Fixes

- `decx self install` / `self update` no longer use the GitHub REST API, which is rate-limited to 60 requests/hour for unauthenticated clients. The latest stable version now comes from the npm registry (`@jygzyc/decx-cli` is published from the same tag as `decx-server.jar`), prereleases come from the GitHub releases atom feed, and the jar is downloaded from a deterministic `/releases/download/vX.Y.Z/decx-server-X.Y.Z.jar` URL. No GitHub token or `gh` CLI is required.
- Update checks no longer silently report "Server already up to date" when the check itself failed: HTTP errors, rate limits, and network failures now produce an explicit error.
- Fixed a Windows crash (`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`) caused by `process.exit` racing undici teardown: the CLI now sets `process.exitCode` and lets the event loop drain naturally.
- Replacing `decx-server.jar` while a session is running (the file is locked on Windows) now reports a clear error telling the user to close sessions, cleans up the partial download, and restores the previous jar.
