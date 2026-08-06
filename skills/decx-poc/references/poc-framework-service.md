---
name: poc-framework-service
description: Framework Binder PoC routing for service calls and race drivers.
---

# Framework Service PoC Reference

## Matrix

| Signal | Shape | Support |
|---|---|---|
| permission/identity/data/intent Binder issue | `binder-caller` | hidden API |
| race condition | `binder-caller` | hidden API + concurrency driver |

## Required Spec Fields

- service name
- interface descriptor
- method or transact code
- parameter types and values
- identity/guard references
- successSignal

## Implementation Slots

- add hidden API exemption (pure-Java reflection preferred; see `poc-base.md` Framework Binder PoC Add-On);
- resolve service via ServiceManager;
- call exactly one verified method/transact path;
- add concurrency only when `pocShape` requires it.

## Exploit Techniques

- oneway binder payload cap is ~half the normal ~1MB (kernel `binder_alloc.c`): in a chain A→B→C where B→C is oneway with attacker-controlled data, size the payload between the two caps so A→B succeeds but B→C fails, breaking system logic.
- in oneway calls `Binder.getCallingPid()` returns 0: pid-comparison auth is bypassable — e.g. taking a dead process's Activity Token.
- leaked `IApplicationThread`: call `performReceiver()` with a forged `ActivityInfo` for code execution; Android 17+ blocks direct calls from non-system uid — try routing it through AMS; the system also authenticates on `IApplicationThread` elsewhere (`startActivity`, `grantUriPermission`).
- Parcel with a `ReadWriteHelper` forces eager deserialization: reading a Bundle on it deserializes all elements at once (defeats Android 13+ lazy Bundle); `RemoteViews` sets a ReadWriteHelper; `AppWidgetManager.setWidgetPreview()`/`getWidgetPreview()` inject/retrieve arbitrary RemoteViews with no notification or interaction; trap: typed `getParcelableArray(Intent.class)` then yields `Parcelable[]` — casting to `Intent[]` throws.
- nested synchronous binder calls dispatch onto the same thread (A.T1→B, B synchronously calls back into A and T1 executes it): force thread re-entry into methods that never expected it.
- `ParceledListSlice`: deserialization immediately synchronous-transacts `FIRST_CALL_TRANSACTION` to the embedded binder — call back into yourself once the target holds a lock (precise-timing execution or blocking the lock-holder); combine with nested calls for forced re-entry.

## Boundary

Do not use app component delivery (`startActivity`, `bindService`, `sendBroadcast`) for framework Binder findings.
