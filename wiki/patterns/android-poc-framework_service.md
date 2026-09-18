---
name: framework_service
track: android-poc
---

# framework_service

## Match
Framework Binder or system service is the target, including race-condition drivers (`binder-caller` shape).

## Non-obvious
- Boundary: app component delivery (`startActivity`, `bindService`, `sendBroadcast`) must never be used for framework Binder findings.
- Hidden-API exemption runs before the first Binder call: reflectively get `dalvik.system.VMRuntime.getRuntime()` and invoke `setHiddenApiExemptions(String...)` with `"L"`; the Maven fallback `org.lsposed.hiddenapibypass:hiddenapibypass:4.0` is only for setups where external libraries are acceptable.
- Resolve the service via `ServiceManager`, call exactly one verified method/transact path, and add concurrency only when `pocShape` requires it.
- Oneway binder payloads cap at roughly half the normal ~1 MB (kernel `binder_alloc.c`): in a chain A→B→C where B→C is oneway, sizing the payload between the two caps makes A→B succeed while B→C fails.
- `Binder.getCallingPid()` returns 0 in oneway calls, so pid-comparison auth is bypassable, for example by taking a dead process's Activity Token.
- A leaked `IApplicationThread` allows `performReceiver()` with a forged `ActivityInfo` for code execution; Android 17+ blocks direct calls from non-system uid, so try routing through AMS.
- The system also authenticates on `IApplicationThread` in `startActivity` and `grantUriPermission`.
- A `Parcel` with a `ReadWriteHelper` forces eager deserialization and defeats Android 13+ lazy Bundle; `RemoteViews` sets one, and `AppWidgetManager.setWidgetPreview()`/`getWidgetPreview()` inject or retrieve arbitrary RemoteViews with no notification or interaction.
- Typed `getParcelableArray(Intent.class)` yields `Parcelable[]`, so casting it to `Intent[]` throws.
- Nested synchronous binder calls dispatch onto the same thread (A.T1→B, B calls back into A, T1 executes it), forcing re-entry into methods that never expected it.
- `ParceledListSlice` deserialization immediately and synchronously transacts `FIRST_CALL_TRANSACTION` to the embedded binder — call back into yourself once the target holds a lock.
- Required spec fields: service name, interface descriptor, method/transact code, parameter types and values, identity/guard references, `successSignal`.

## Reject
The finding is an app component issue mislabeled as framework Binder, or the verified method/transact path is missing — stop; app component delivery is never the framework harness.
