---
name: service
track: android-poc
---

# service

## Match
Service is the entry: `onStartCommand()` extras/action, AIDL/Binder exposure, Messenger protocol, or foreground notification observation.

## Non-obvious
- Shape mapping: start → `direct-trigger`; AIDL/Binder → `binder-caller` with direct transact or a minimal interface; Messenger → `binder-caller` with Messenger message fields; foreground notification leak → `ui-assisted` with an observer only if the spec requires it.
- Direct `transact` is preferred whenever full AIDL reconstruction is unnecessary.
- Main-thread auth in `onBind()` is void: a victim Service calling `enforceCallingOrSelfPermission()` there checks itself, not the binder caller — the PoC just binds and calls; the same mistake in `Activity.onCreate()` has the same consequence.
- The service class, action/extras or bind target, Binder descriptor/transact code, and Messenger `what`/args/payload are required spec fields; the PoC calls exactly one verified path.

## Reject
The spec omits the service class, Binder descriptor/transact code or Messenger payload — stop instead of reverse-engineering the interface inside the harness.
