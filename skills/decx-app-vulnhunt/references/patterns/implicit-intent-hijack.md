# Pattern: Implicit Intent Hijack

## Match

Sensitive data, URI grant, callback, result, or protected workflow sent through implicit `Intent` resolution — any app with matching `<intent-filter>` and higher priority can receive, modify, or satisfy the request.

High-signal trigger shapes:
- Implicit `startActivity` carrying token/password/grant flag — attacker enters the chooser.
- Implicit `startService` carrying a privileged command — Android 5+ blocks implicit `bindService` but NOT `startService` on exported services.
- Activity-for-result with implicit Intent — attacker returns forged grant-bearing `Intent` via `setResult`.

## Analyze

- entry: `startActivity`, `startService`, `startActivityForResult` with implicit Intent (no explicit component)
- control: resolver target (action/data/type), extras, grant flags, chooser default
- sink: grant-bearing payload (`FLAG_GRANT_READ_URI_PERMISSION` / `FLAG_GRANT_WRITE_URI_PERMISSION`), forged result Intent via `setResult`, protected workflow continuation
- guard: explicit target (`setClassName` / `setComponent`), avoid `startActivityForResult` with implicit Intent; `setPackage` is not enough — resolver picks any matching activity inside target package
- impact: `content://` grant leak, result manipulation, attacker interposed in trusted workflow chain

> **`setPackage` is not a safety guarantee** — the resolver can still pick any matching activity within that package. Verify the resolved `ActivityInfo`. Also see broadcast-abuse for the ordered-broadcast receiver-vs-result distinction.

## Reject

Reject when target is explicit (`setClassName` / `setComponent`), payload is public, or recipient verified before trust. Note: `setPackage(packageName)` still allows any matching activity inside that package — verify `ActivityInfo`.

## Codes

```java
// implicit Intent with grant flag + content:// — attacker app with matching filter is offered as target
intent.setData(Uri.parse("content://victim.fileprovider/.../secret.txt"));
intent.setFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
startActivityForResult(intent, 0);
```

```java
// implicit startService carrying a privileged command (Android 5+ still allows this on exported service)
startService(new Intent("com.example.SEND_SMS").putExtra("number", "...").putExtra("body", "..."));
```

```java
// higher-priority dynamic receiver intercepts a system broadcast
filter.setPriority(Integer.MAX_VALUE);
registerReceiver(attackerReceiver, filter);
```

```java
// implicit Intent for result — attacker returns a forged grant-bearing result
startActivityForResult(new Intent("com.example.PICK_CONTACT"), 3);
```
