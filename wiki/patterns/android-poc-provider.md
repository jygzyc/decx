---
name: provider
track: android-poc
---

# provider

## Match
ContentProvider is the entry: query/SQL injection/`getType()`, file or path access, `call()`/batch, or a returned grant/FileProvider chain.

## Non-obvious
- Shape mapping: query/getType/file/call/batch → `direct-trigger` with no support; returned grant or FileProvider chain → `returned-handle` with a capture step only if the spec proves it.
- `openFile()` mode `"rw"` checks only the write permission and ignores read.
- Older versions accepted `"rt"`/`"ra"` and read-checked only those modes, so truncation slipped through; Android 17+ throws on them.
- A protected provider's `openFile()`/`getType()` can be system-triggered by placing the URI into an icon the system displays; on old patch levels `ActivityManager.openContentUri()` opened it as the system and handed back the fd.
- Call exactly one provider API family from the spec; grant acquisition is never invented inside the PoC.

## Reject
The spec lacks the provider authority, URI/method/batch body or a proven grant source — stop instead of guessing the authority or fabricating the grant path.
