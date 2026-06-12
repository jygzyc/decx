# Pattern: PendingIntent Abuse

## Match

Attacker influences `PendingIntent` creation, accepts/supplies one, controls mutable/fill-in fields, or triggers dispatch via notification/widget/alarm/shortcut/callback.

The Android 12+ default for `PendingIntent` is now `FLAG_MUTABLE` (changed from `FLAG_IMMUTABLE`); still treat any caller-supplied `PendingIntent` or any `PendingIntent` created with `FLAG_MUTABLE` / without explicit `FLAG_IMMUTABLE` as untrusted. `FLAG_UPDATE_CURRENT` + a stable request code lets the creator overwrite a previously granted `PendingIntent` with attacker-controlled extras.

Common primitives:
- `PendingIntent.getActivity` / `getService` / `getBroadcast` / `getActivities` / `getForegroundService` with `FLAG_MUTABLE` and attacker-controlled `Intent` — recipient can call `pendingIntent.send(this, 0, mutatedIntent)` to launch under creator identity.
- Notification action `PendingIntent` that the user can trigger (the user is the carrier) — but extras in the wrapped Intent may be attacker-controlled if the notification is built from a server response.
- AppWidget host `PendingIntent` that the desktop process fires on user click — desktop identity, victim-app's permission.
- queued callback or remote-view style payload carries a parcelable across process boundaries and is parsed again at dispatch (see `object-parsing-abuse`).
- Caller-supplied `PendingIntent` received via Intent extra; the receiver then calls `send()` without checking whether the PendingIntent is the one the receiver originally created (request-code collision via `FLAG_UPDATE_CURRENT`).

## Analyze

- entry: `PendingIntent.getActivity` / `getService` / `getBroadcast` / `getActivities` / `getForegroundService`, received `PendingIntent` extra, notification action, app widget, alarm, shortcut, callback token, queued callback item
- control: target `component` / `package`, action, data URI, extras, request code, flags (`FLAG_IMMUTABLE` / `FLAG_MUTABLE` / `FLAG_UPDATE_CURRENT` / `FLAG_ONE_SHOT` / `FLAG_CANCEL_CURRENT`), mutability, fill-in mask, grant fields
- sink: `PendingIntent.send`, delayed dispatch, target component/service/receiver, URI grant (`FLAG_GRANT_*` on the wrapped Intent), protected action executed by creator identity
- guard: `FLAG_IMMUTABLE` for any externally delivered PI, explicit trusted target, fill-in restriction, target-side authorization (`getCallingPackage()` / `getCallingUid()`) at the `send()` receiver, never use `FLAG_UPDATE_CURRENT` on attacker-controlled request code
- impact: victim identity launch/grant, private component reachability, replay/collision, leverage into `object-parsing-abuse` chain when PI carries a Parcelable or remote callback payload

## Reject

Reject when PI is `FLAG_IMMUTABLE` with trusted constants, attacker cannot obtain/trigger it, target rechecks authorization before sensitive work, or execution reaches only harmless UI.

## Codes

```java
// mutable PI handed as extra — recipient can mutate and send under creator identity
PendingIntent pi = PendingIntent.getActivity(ctx, 0, intent1, PendingIntent.FLAG_MUTABLE);
intent1.putExtra("PENDING", pi);
startActivity(intent1);
```

```java
// recipient mutates Intent and sends under creator identity — fill-in mask
Intent inner = new Intent();
inner.putExtra("code", 42);
pi.send(this, 0, inner);
```

```java
// queued callback carries a remote-view shaped Parcelable into a later parse
queue.add(inner.getParcelableExtra("p"));
```

```java
// receiver blindly re-dispatches a caller-supplied PI
PendingIntent pi = intent.getParcelableExtra("pending_intent");
pi.send(this, 0, intent);
```

```java
// FLAG_UPDATE_CURRENT + attacker-controlled request code overwrites previously-granted PI
PendingIntent.getActivity(ctx, 0, newIntent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE);
```
