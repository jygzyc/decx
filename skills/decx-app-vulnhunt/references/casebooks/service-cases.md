# Casebook: Service Command Injection

Use this casebook after [[patterns/service-command-injection]]. These cases are abstract exploit shapes, not reproduction instructions.

## Case: AIDL Method Trusts Caller Args Without Binder Validation

### Abstract Shape

```text
external app -> bindService -> AIDL method(query params) -> database query with caller params -> protected data returned
```

### Key Mistake

An exported AIDL interface method uses caller-supplied parameters directly in a database query or file operation without verifying the caller's UID via `Binder.getCallingUid()`.

### Why It Was Exploitable

- the AIDL service is exported and any app can bind to it
- the method signature accepts query parameters such as selection, projection, or sort order
- no Binder identity check verifies that the caller is authorized for the requested data scope
- the method returns rows or files that should be restricted to the owning app

### Generalized Detection Rule

Every exported AIDL method must check `Binder.getCallingUid()` or `Binder.getCallingPid()` and map it to an authorized data scope before processing caller-supplied arguments.

Related: [[patterns/service-command-injection]]

## Case: onStartCommand Action String Dispatches To Privileged Operation

### Abstract Shape

```text
external app -> startService(action="admin_action", extras) -> onStartCommand dispatches on action -> privileged admin operation executed
```

### Key Mistake

An exported service uses `Intent.getAction()` in `onStartCommand()` to dispatch to different internal operations without validating the action against an allowlist.

### Why It Was Exploitable

- the service is exported and can be started by any application
- `onStartCommand()` switches on the action string without checking caller identity
- one or more dispatch branches perform privileged operations such as resetting config, deleting data, or elevating permissions
- the action strings are predictable and discoverable through static analysis

### Generalized Detection Rule

Dispatch logic in `onStartCommand()` must validate both the action string against a fixed allowlist and the caller identity before executing any privileged operation.

Related: [[patterns/service-command-injection]]

## Case: Messenger msg.what Routes To Unprotected Helper

### Abstract Shape

```text
external app -> bound service -> Messenger.send(msg) -> handleMessage dispatches on msg.what -> sensitive helper called without authorization
```

### Key Mistake

An exported service exposes a Messenger interface whose handler dispatches on `msg.what` without exhaustive case validation, allowing external callers to reach a sensitive helper method.

### Why It Was Exploitable

- the service returns a Messenger from `onBind()`, making it accessible to all apps
- `handleMessage()` uses a switch on `msg.what` but does not cover all cases or validate the caller
- a sensitive helper method is reachable through an undocumented or unguarded `msg.what` value
- the helper method performs operations such as writing shared preferences, accessing accounts, or sending broadcasts

### Generalized Detection Rule

Messenger handlers must validate the caller identity from `msg.replyTo` or `Messenger.getBinder()` and must reject any `msg.what` value not on an explicit allowlist.

Related: [[patterns/service-command-injection]]

## Case: Foreground Notification Exposes Sensitive Token Value

### Abstract Shape

```text
service -> startForeground(notification) -> notification text contains auth token -> any app reads notification via NotificationListenerService
```

### Key Mistake

The service builds its foreground notification with session tokens, API keys, or credentials from the current operation, making them visible to any app with notification access.

### Why It Was Exploitable

- `startForeground()` posts a notification visible to the user and to any app with `BIND_NOTIFICATION_LISTENER_SERVICE`
- the notification title, text, or big text contains authentication tokens, passwords, or session identifiers
- the sensitive value is included for debugging convenience or to show "logged in as <token>"
- notification listener services can read the full notification content including all text fields

### Generalized Detection Rule

Never embed secrets in foreground notification text. Show only non-sensitive identifiers such as a username or connection status, and store the actual token in memory or encrypted storage.

Related: [[patterns/service-command-injection]]
