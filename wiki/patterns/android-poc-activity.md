---
name: activity
track: android-poc
---

# activity

## Match
An exported Activity is the entry: direct launch, redirect, fragment/traversal, `setResult()` capture, or task/UI/lifecycle abuse.

## Non-obvious
- The spec signal fixes shape and support: exported direct launch / redirect / fragment / traversal → `direct-trigger` with no helper component.
- `setResult()` or a returned handle → `returned-handle`; a helper Activity is added only when capture is required and proven.
- Task hijack / clickjacking / lifecycle → `ui-assisted`; helper Activity or overlay only if the spec requires it.
- Implement exactly one launch/capture/UI-assisted method — building all three breaks the one-spec/one-exploit-id rule.
- Cross-reference: task/UI/lifecycle findings prefer this page; PendingIntent, URI grant and implicit Intent findings prefer `references/android-poc-intent.md` even when an Activity delivers them.

## Reject
The spec lacks the activity class, action/data/categories/extras, returned handle or `successSignal`, or capture is inferred rather than proven — stop instead of guessing a launch.
