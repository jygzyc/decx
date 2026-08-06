---
name: poc-app-service
description: Service PoC routing for startService, bind/transact, Messenger, and notification observation.
---

# Service PoC Reference

## Matrix

| Signal | Shape | Support |
|---|---|---|
| `onStartCommand()` extras/action | `direct-trigger` | none |
| AIDL / Binder exposure | `binder-caller` | direct transact or minimal interface |
| Messenger protocol | `binder-caller` | Messenger message fields |
| foreground notification leak | `ui-assisted` | observer only if spec requires |

## Required Spec Fields

- service class
- action/extras or bind target
- Binder descriptor/transact code or interface method
- Messenger `what`/args/payload, if used
- successSignal

## Implementation Slots

- choose start, bind/transact, or Messenger path only;
- prefer direct transact when full AIDL reconstruction is unnecessary.

## Exploit Techniques

- main-thread auth in `onBind()` is void: a victim Service calling `enforceCallingOrSelfPermission()` inside `onBind()` checks itself (main thread, not a binder thread) — the PoC just binds and calls; variant: same mistake in `Activity.onCreate()`.
