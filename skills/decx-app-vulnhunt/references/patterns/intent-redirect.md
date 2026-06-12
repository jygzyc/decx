# Pattern: Intent Redirect

## Match

Exported component, WebView/native scheme router, deep-link handler, AIDL/Binder callback, PendingIntent `send`, notification path, or app bridge forwards caller-controlled `Intent`, `Uri`, `ClipData`, selector, component, package, action, flags, or extras to a downstream sink.

Common upstream shapes:
- `getParcelableExtra("...")` / `getBundleExtra("...").getParcelable("...")` returns a nested `Intent` and the code calls `startActivity` / `startActivityForResult` / `startService` / `bindService` / `sendBroadcast` on it.
- WebView `shouldOverrideUrlLoading` or `Intent.parseUri(url, URI_INTENT_SCHEME)` dispatches an `intent://...end` payload without stripping `component` / `package` / `selector` / `FLAG_GRANT_*` / `ClipData` (IntentScheme URL).
- `setResult(RESULT_OK, intent)` returns the same caller-supplied `Intent` (or a copy that still carries `FLAG_GRANT_READ_URI_PERMISSION` / `FLAG_GRANT_WRITE_URI_PERMISSION` and a `content://` URI) back to the caller.
- Exported Activity/Receiver with `intent-filter` accepts external action+extras and uses them to call `startActivity` / `startActivityForResult` / `sendBroadcast` / `bindService`.
- PendingIntent created with `FLAG_MUTABLE` or with a fill-in mask, then handed to another component which calls `pendingIntent.send(this, 0, intent)`.

## Analyze

- entry: exported Activity/Service/Receiver, `startActivityForResult` result callback, `Intent.parseUri`, nested `Intent` extra from `Bundle.getParcelable`/`getBundle*`, deep-link path, `shouldOverrideUrlLoading`, `PendingIntent.send` callback, AIDL `Stub.onTransact`
- control: target `component` / `package` / `selector`, `action`, `data` URI, `ClipData`, `FLAG_GRANT_READ_URI_PERMISSION` / `FLAG_GRANT_WRITE_URI_PERMISSION` / `FLAG_GRANT_PERSISTABLE_URI_PERMISSION` / `FLAG_GRANT_PREFIX_URI_PERMISSION`, `categories`, extras, request/result path, account / file / target id
- sink: `startActivity`, `startActivityForResult`, `startService`, `bindService`, `sendBroadcast`, `setResult`, `grantUriPermission`, helper launch/return/grant wrapper, WebView `loadUrl(attackerUrl)` reached via a nested Intent
- guard: exact target/component allowlist; `Intent.getPackage()` equals self (component field has higher precedence — see Codes); caller identity via `getCallingActivity()` / `getCallingPackage()` (caller can be `null`); strip `FLAG_GRANT_*` and rebuild `Intent` before forwarding; never pass raw `Intent.parseUri` output to `startActivity`
- impact: launch private/non-exported component, grant attacker access to victim's `content://` provider (incl. FileProvider with broad `root-path`), bypass logic depending on trusted internal result, chain into WebView/provider/broadcast/redirect for further primitives

## Reject

Reject when the forwarded `Intent` is rebuilt from trusted constants (only `Uri`/extras copied, no `component`/`package`/`flags`/`selector` change), the resolved target is exact-allowlisted, dangerous fields and grant flags are stripped before the sink, the nested `Intent` only carries data consumed by the same trusted class, the sink is unreachable, or the downstream target has no protected behavior/data.

## Codes

```java
// nested Intent extra read from the bridge, dispatched as-is
Intent deeplinkIntent = (Intent) getIntent().getParcelableExtra("extra_deep_link_intent");
startActivity(deeplinkIntent);
```

```java
// WebView dispatches intent:// via parseUri without host allowlist
if ("intent".equals(uri.getScheme())) {
    startActivity(Intent.parseUri(uri.toString(), Intent.URI_INTENT_SCHEME));
}
```

```java
// package equality is not enough — component field has higher precedence than package
if (!packageName.equals(activityInfo.packageName)) throw new SecurityException(...);
```

```java
// for-result with implicit Intent — attacker returns a forged grant-bearing result
startActivityForResult(new Intent("com.example.PICK_CONTACT"), 3);
```
