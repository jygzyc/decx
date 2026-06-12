# Pattern: Framework Service PendingIntent

## Match

Framework service creates, stores, mutates, sends, cancels, or accepts `PendingIntent` where caller controls target, extras, flags, package, request code, user, fill-in data, or callback token. The framework helper anti-pattern is creating a `PendingIntent` with an empty base `Intent` and no `FLAG_IMMUTABLE`; the recipient receives it, fills in the action, and the PI dispatches under the framework system identity. The same shape recurs in any framework helper that hands out a `PendingIntent` for an `addAccount` response, a notification action, a media-session event, or a credential reset.

## Analyze

- trace PI creation and PI dispatch separately. At creation, prove who controls base `Intent`, flags, request code, package/user, and mutability; at dispatch, prove whether fill-in, replay, collision, or delayed callbacks can change the final target or grant.
- entry: Binder method/callback, notification/alarm/session helper, stored caller-provided `PendingIntent`, account/credential response `Bundle`, notification builder, widget/remote-view click handler
- control: target, action/data/extras, flags (`FLAG_IMMUTABLE` / `FLAG_MUTABLE` / `FLAG_UPDATE_CURRENT` / `FLAG_ONE_SHOT` / `FLAG_CANCEL_CURRENT`), request code, package/user, mutability, fill-in mask, creator/sender identity, target SDK level (`FLAG_IMMUTABLE` default on pre-31, `FLAG_MUTABLE` default on 31+)
- sink: `PendingIntent.get*`, `pendingIntent.send`, delayed dispatch, privileged launch/grant/broadcast, replay/collision, master-clear / device-admin / account-remove trigger
- guard: immutable flag (`FLAG_IMMUTABLE` on every externally delivered PI), exact hardcoded target with no caller-influence, caller-bound package/UID/user, fill-in restriction, execution-time authorization (re-check on dispatch), no selector / ComponentName in the PI base intent, on target SDK 31+ explicitly mark `FLAG_MUTABLE` only when fill-in is required and the fill-in is bounded
- impact: system/framework identity launch/grant/action, wrong victim identity, replay, collision, cross-user dispatch, privileged reset, admin removal, or listener/role grant

## Required Trace Evidence

Reachability, Controllability, Sink, Missing guard, Visible impact

## Reject

Reject when PI is immutable with trusted constants, attacker cannot obtain/trigger it, target rechecks authorization before sensitive work, or caller-controlled fields are stripped before dispatch. For stored PIs, reject when the stored PI is keyed on a stable non-attacker request code and target re-validates the original caller.

## Codes

```java
// stored callback object carries attacker-shaped Parcelable into a later privileged dispatch
storedCallback.setPayload(attackerParcelable);
```

```java
// empty mutable base PI lets recipient fill target/action at dispatch
PendingIntent pi = PendingIntent.getActivityAsUser(
        context, 0, new Intent(), 0, null, UserHandle.SYSTEM);
```

```java
// boundary mistake: mutable "only for extras"; fill-in replaces data/grants too
Intent fillIn = new Intent(Intent.ACTION_VIEW, attackerUri);
fillIn.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
pi.send(context, 0, fillIn);
```

```java
// extreme edge: stable requestCode collision lets attacker replace stored PI
PendingIntent stored = PendingIntent.getActivity(
        context, 0, attackerIntent, PendingIntent.FLAG_UPDATE_CURRENT);
```
