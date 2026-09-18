---
name: broadcast
track: android-poc
---

# broadcast

## Match
Broadcast or receiver is the entry: direct send, ordered interception, permission bypass, or global leak.

## Non-obvious
- Shape mapping: dynamic receiver or permission bypass → `direct-trigger` with no helper or a declared permission; ordered-broadcast mutation and global leak → `interception` with a runtime receiver.
- A receiver is registered only when capture or interception is required; a direct send must not register one.
- The ordered result fields and the register-then-trigger order come from the spec — do not invent extra keys.
- A declared permission is part of `supportComponents`; the action, extras/categories and permission (if required) are required spec fields before any code exists.

## Reject
Interception is needed but the spec does not name the action, ordered result fields or permission — stop instead of registering a receiver against an unknown protocol.
