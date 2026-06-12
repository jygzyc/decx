# Pattern: Lifecycle State Exposure

## Match

Sensitive state, grant, result, WebView context, recording/location/network action, credential/session UI, callback, or background work survives lifecycle or task transitions into attacker-relevant context. Common patterns:
- Sensitive action (camera/mic/location/file/network) closed in `onDestroy` instead of `onPause` — when the app goes to background, the action still runs; an attacker-arranged task switch exposes the action to a phishing UI.
- Stale `Intent` from a previous launch preserved into a new task — reuse of an `Intent` that still carries `FLAG_GRANT_READ_URI_PERMISSION` or a granted `content://` URI.
- Service `START_REDELIVER_INTENT` re-delivers the attacker-controlled Intent on process restart — every `onStartCommand` after a crash is an attacker message.
- Service `onStartCommand` with no input validation runs in the main thread; a malformed Parcelable (`Bundle` containing a bad `String[]` or a `Serializable` gadget) blocks the main thread (DoS) and the redelivery keeps the same payload.
- Saved-instance `Bundle` re-parse on configuration change: a `Bundle` re-read in `onCreate(savedInstanceState)` may execute the same Parcelable reflection as a fresh external Intent (leverage `object-parsing-abuse`).
- `onNewIntent` overwrites `getIntent()` without clearing extras; combined with `singleTask` / `singleTop`, an attacker re-launches with a different Intent that the activity treats as a continuation of the previous session.

## Analyze

- trace the same attacker-controlled object across lifecycle callbacks, not just the first entry. Compare where it is consumed, where it is cleared, and whether a later callback reuses it after task switch, process restart, or configuration change.
- entry: `onNewIntent` (`singleTask`/`singleTop` overwrites `getIntent()`), `onCreate(savedInstanceState)`, `onStartCommand` (re-delivery), `onPause`/`onDestroy` boundary
- control: external re-launch, stale Intent, task switch, process restart (redelivery)
- sink: continued sensitive work after background (camera/mic/location), stale grant/URI reuse, WebView context, file write through open FileProvider
- guard: close sensitive actions in `onPause` (not `onDestroy`), `setIntent(new Intent())` after consuming extras, treat `START_REDELIVER_INTENT` as attacker-controlled, discard stale grants on entry
- impact: background action survives into attacker-arranged phishing context, grant/URI persistence, service DoS via malformed Parcelable re-delivery

> **`START_REDELIVER_INTENT`** re-delivers attacker payload on every crash — a stable DoS primitive requiring no new intent. See also: service-command-injection, object-parsing-abuse.

## Reject

Reject when state is cleared/revalidated before reuse, background work is canceled/gated, or no sensitive state survives the transition.

## Codes

```java
// onNewIntent without clearing extras — attacker re-launches with a different Intent that overwrites the trusted state
setIntent(intent);
handleIntent(intent);
```

```java
// START_REDELIVER_INTENT — every crash re-delivers the attacker payload
return START_REDELIVER_INTENT;
```

```java
// safe: consume once, then clear stale input and close sensitive work on background
handleExternalIntent(intent);
setIntent(new Intent());

@Override protected void onPause() {
    super.onPause();
    cameraRecorder.stop();
}
```

```java
// boundary mistake: savedInstanceState re-parses the same untrusted fragment name
Fragment f = Fragment.instantiate(this, savedInstanceState.getString("fragment_name"), null);
```

```java
// extreme edge: camera/recorder closed in onDestroy, not onPause; task switch leaves it live
@Override protected void onDestroy() {
    super.onDestroy();
    cameraRecorder.stop();
}
```
