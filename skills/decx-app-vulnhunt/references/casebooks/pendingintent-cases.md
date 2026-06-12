# Casebook: PendingIntent Abuse

Use this casebook after [[patterns/pendingintent-abuse]]. These cases are abstract exploit shapes, not reproduction instructions.

## Case: Mutable PendingIntent Redirects Victim Identity

### Abstract Shape

```text
victim creates mutable PendingIntent -> attacker obtains/fills it -> changed target/extras -> victim-identity action
```

### Key Mistake

The app creates or accepts a mutable `PendingIntent` where the target, action, data, extras, or grant-bearing fields remain attacker-controllable.

### Why It Was Exploitable

- attacker can receive, reuse, or supply the `PendingIntent`
- fill-in or mutable fields alter the security-relevant operation
- dispatched action runs as the creator rather than the presenter
- target component, URI, or extras reach privileged app behavior

### Generalized Detection Rule

Require immutable PendingIntents by default, explicit targets for mutable cases, and tight fill-in masks when caller input can influence dispatch.

### Related

[[patterns/pendingintent-abuse]], [[patterns/intent-redirect]], [[patterns/uri-grant-leak]]

## Case: Mutable PendingIntent Lets Attacker Modify Target Component

### Abstract Shape

```text
app creates PendingIntent(FLAG_MUTABLE) -> attacker intercepts -> fillIn() modifies component/extras -> PendingIntent.send() -> private Activity launched
```

### Key Mistake

The app creates a PendingIntent with `FLAG_MUTABLE`, allowing any holder of the PendingIntent token to modify the inner Intent before it is dispatched.

### Why It Was Exploitable

- `FLAG_MUTABLE` permits the inner Intent to be modified via `Intent.fillIn()`
- an attacker who obtains the PendingIntent can change the component, action, data, or extras
- the PendingIntent retains the identity of the creator app when eventually sent
- the modified Intent executes under the victim app's permissions and identity

### Generalized Detection Rule

Always create PendingIntents with `FLAG_IMMUTABLE`. If mutability is required for legacy compatibility, explicitly restrict which fields may be changed and validate the inner Intent before dispatch.

Related: [[patterns/pendingintent-abuse]]

## Case: Notification Action PendingIntent Forwards Victim Identity

### Abstract Shape

```text
malicious app -> notification with PendingIntent -> user taps -> PendingIntent.send() under victim identity -> protected action triggered
```

### Key Mistake

The app posts a notification whose action PendingIntent targets a protected component of another app, and tapping the notification sends the PendingIntent under the creator's identity.

### Why It Was Exploitable

- PendingIntent executes with the identity and permissions of the app that created it
- a malicious app crafts a PendingIntent targeting a private or protected component in the victim app
- the notification system delivers the PendingIntent tap as the victim app
- the protected action cannot distinguish between a legitimate internal trigger and the forged PendingIntent

### Generalized Detection Rule

When handling PendingIntents from external sources, verify that the target component belongs to the calling app or explicitly validate the creator identity via `PendingIntent.getCreatorPackage()`.

Related: [[patterns/pendingintent-abuse]]

## Case: fillInIntent Overrides Trusted Action Fields

### Abstract Shape

```text
external app -> AIDL method with Intent param -> PendingIntent sent with caller-controlled fillIn -> protected broadcast sent under victim identity
```

### Key Mistake

An AIDL interface method accepts an Intent parameter and uses it to fill in a PendingIntent via `fillIn()`, allowing the caller to override fields that were supposed to be trusted.

### Why It Was Exploitable

- the AIDL method is exported and callable by any app that binds to the service
- the caller-supplied Intent is passed to `fillIn()` on the PendingIntent's inner Intent
- action, component, data, or extras fields are overwritten with attacker-controlled values
- the PendingIntent is then sent, executing the modified intent under the victim app's identity

### Generalized Detection Rule

Never pass untrusted Intent parameters to `fillIn()` on a PendingIntent. If the API requires caller input, extract only specific typed values and set them individually rather than accepting a full Intent.

Related: [[patterns/pendingintent-abuse]]

## Case: Alarm PendingIntent Reuses Victim Package For Protected Broadcast

### Abstract Shape

```text
app -> AlarmManager.set(PendingIntent) -> PendingIntent target can be redirected -> protected broadcast sent at scheduled time under victim identity
```

### Key Mistake

The app schedules an alarm using a mutable PendingIntent; an attacker who gains access to the alarm's PendingIntent can redirect the target component or action.

### Why It Was Exploitable

- the PendingIntent used with `AlarmManager` is created with `FLAG_MUTABLE`
- the alarm system holds a reference to the PendingIntent that persists across app boundaries
- an attacker modifies the inner Intent component or extras before the alarm fires
- when the alarm triggers, the modified broadcast or activity launch executes as the victim app

### Generalized Detection Rule

Use `FLAG_IMMUTABLE` for all alarm PendingIntents. If the alarm payload must vary, store the varying data in a local database and retrieve it at dispatch time rather than embedding it in the PendingIntent.

Related: [[patterns/pendingintent-abuse]]
