# Pattern: Service Command Injection

## Match

Exported service, `IntentService`, AIDL/Binder, `Messenger`, Job/WorkManager handoff consuming attacker-controlled action, extras, command, URI, path, nested `Intent`, message, or `replyTo`. Implicit `<intent-filter>` means `exported="true"` unless explicit declaration on API 31+.

High-signal trigger shapes:
- `startService` / `startService` (deprecated) with implicit Intent carrying a `command` extra — service routes to `onStartCommand` and dispatches the command to a privileged action (e.g. SMS send, file write, dial).
- `bindService` returning a binder stub to a sensitive AIDL — the attacker can `transact` any method without the original `.aidl` file by generating the `Stub` interface from the decompiled `Stub$Proxy` class or by `dex2jar`-ing the app and using the produced jar as a library.
- `Messenger` from `onBind` whose `Handler` dispatches `msg.what` / `Bundle` to a command switch.
- AIDL `Stub.onTransact` reading a `Parcelable` argument that comes from a public-extras path; subclass/reader mismatch can shift the read and reach privileged branches.
- `IntentService` (deprecated) with `onHandleIntent` that does not check action / null extras / wrong type — deserialization exceptions in `getSerializableExtra` / `getParcelableExtra` cause `RuntimeException` and crash the service (denial of service primitive).

## Analyze

- entry: `onStartCommand`, `onHandleIntent`, `Stub.onTransact` (AIDL), `Messenger.handleMessage`, `onBind` returning attacker-reachable IBinder
- control: action string, command name, `msg.what`, URI/path, nested `Intent`, `replyTo` Messenger, `Parcelable` creator mismatch
- sink: arbitrary AIDL method invocation (attacker needs `Stub` bytecode, not `.aidl` source), protected action (SMS/dial/file/provider), `PendingIntent` send
- guard: `Binder.getCallingUid()` before each privileged branch, mark internal services `exported="false"`, explicit `exported` on API 12+, never return sensitive stub from `onBind` without caller check
- impact: victim performs protected work on attacker's behalf, data exfiltration, AIDL surface exposes privileged methods

## Reject

Reject when service unreachable, command from trusted constants, or AIDL method unreachable to privileged branch on attacker input.

## Codes

```java
// command dispatched from external Intent to privileged action (sender / body fully attacker-controlled)
SmsManager.getDefault().sendTextMessage(intent.getStringExtra("number"), null, intent.getStringExtra("body"), null, null);
```

```java
// type-confusion DoS — no type check on the extra
SomeData data = (SomeData) intent.getSerializableExtra("data");
```

```java
// Messenger handler trusts msg.what + Bundle, no caller check
switch (msg.what) { case MSG_DO_PRIVILEGED: doPrivilegedWork(msg.getData().getString("target")); break; }
```

```java
// AIDL onTransact with creator-mismatched Parcelable. See object-parsing-abuse.
Intent _arg2 = _Parcel.readTypedObject(data, Intent.CREATOR);
```

```java
// onBind returns a sensitive AIDL stub to any caller — no caller check
return downloadServiceHandler.onBind(intent);
```
