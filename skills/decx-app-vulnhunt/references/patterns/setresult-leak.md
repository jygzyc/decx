# Pattern: setResult Leak

## Match

Externally triggered Activity or Activity Result path returns sensitive data, URI, grant flags, or internal state through `setResult` or a finish helper. High-signal shapes:

1. **Result identity branch always returns** — a verification/identity page that calls `setResult(RESULT_OK, sensitiveIntent)` regardless of success or failure, even on cancel/back/finish. Any caller that launches via `startActivityForResult` receives the payload.
2. **Caller-supplied Intent returned verbatim** — `setResult` returns the caller's exact `Intent` without rebuilding. The caller can pre-load `FLAG_GRANT_READ_URI_PERMISSION` / `FLAG_GRANT_WRITE_URI_PERMISSION` and a `content://` URI; the result gives the caller temporary grant to the victim's FileProvider (or to any other `grantUriPermissions="true"` provider) under the victim's identity.
3. **Identity-driven Intent swap** — when `requestCode` matches a specific value, the result Intent is the caller's original input. The attacker uses the victim's `READ_CONTACTS` (or `SEND_SMS` / `READ_SMS` / external storage) permission by routing the call through the vulnerable activity; the activity returns a result the attacker would never have obtained directly.

`setResult` is the same primitive as `Intent redirect` in reverse; always cross-check the calling primitive when the entry is `startActivityForResult`.

## Analyze

- trace from the launchable Activity to every exit path (`finish`, back press, cancel button, callback completion, exception cleanup). Treat `setResult` inside helpers as the sink even when the Activity method name is harmless.
- entry: exported Activity, activity-for-result path, Activity Result API callback (`ActivityResultCallback`), scan/file/account picker, finish helper, `onBackPressed` that still calls `setResult`
- control: caller identity (`getCallingActivity()` / `getCallingPackage()`), request parameters, URI/account/file/object selector, returned `Intent` fields (especially `flags`, `data`, `extras`, `ClipData`), grant flags, `requestCode` value used as a branch key
- sink: `setResult(RESULT_OK, intent)`, returned data/extras/ClipData, callback result, URI permission grant (via returned Intent's grant flags)
- guard: grant flag stripping, output allowlist, rebuild the result `Intent` from trusted constants instead of forwarding the caller's payload, only call `setResult` on the success path (or with the same redaction logic on the failure path)
- impact: attacker receives protected data (identity, token, file URI, contact, SMS), grant to a protected `content://` provider, or selected internal state. Permission routing impact: the attacker inherits the victim's runtime permissions for the duration of the result path.

## Reject

Reject when result data is non-sensitive, Activity is not externally reachable for result, caller cannot influence protected data selection, or success result is gated by a non-bypassable trust check.

## Codes

```java
// identity page returns PII on every exit path, including cancel/back/finish
getActivity().setResult(Activity.RESULT_OK, createResultIntent());
getActivity().finish();
```

```java
// caller's exact Intent (with FLAG_GRANT_*) returns through setResult
if (tokenValid) setResult(RESULT_OK, intent);
```

```java
// safe: rebuild the output and strip grants instead of forwarding caller input
Intent out = new Intent();
out.putExtra("account_id", selectedPublicId);
out.setData(null);
out.setClipData(null);
out.setFlags(out.getFlags() & ~(Intent.FLAG_GRANT_READ_URI_PERMISSION
        | Intent.FLAG_GRANT_WRITE_URI_PERMISSION));
setResult(RESULT_OK, out);
```

```java
// boundary mistake: only success strips grants; cancel/back leaks the original input
if (success) {
    setResult(RESULT_OK, sanitizedResult());
} else {
    setResult(RESULT_CANCELED, getIntent());
}
```

```java
// extreme edge: requestCode branch forwards attacker's Intent as victim permission router
if (requestCode == PICK_CONTACTS) {
    intent.setData(ContactsContract.Contacts.CONTENT_URI);
    intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
    setResult(RESULT_OK, intent);
}
```
