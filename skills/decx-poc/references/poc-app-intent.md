---
name: poc-app-intent
description: Intent PoC routing for PendingIntent, URI grants, implicit intents, classloader, and parcel mismatch.
---

# Intent PoC Reference

## Matrix

| Signal | Shape | Support |
|---|---|---|
| mutable PendingIntent / returned handle | `returned-handle` | capture step only if proven |
| URI grant / implicit Intent | `interception` | helper component matching spec |
| classloader / parcel mismatch | `direct-trigger` | custom payload only if proven |

## Required Spec Fields

- source of handle or trigger Intent
- target action/component/data
- extra keys / flags / grant URI
- capture step, if proven
- successSignal

## Implementation Slots

- implement capture and trigger as separate methods for two-stage flows.

## Exploit Techniques

- victim only checks the intent target before `startActivity()`: (a) uncleared flags — ship `FLAG_GRANT_READ/WRITE_URI_PERMISSION` to access providers as the victim (FileProvider converts to file write); (b) "exported, unprotected" system confused deputies — `ChooserActivity`/`ResolverActivity` forward as the caller, `SearchResultTrampoline` sends the intent as system, `CertInstaller` silently installs certs, `PackageInstaller` bypasses unknown-sources; (c) pass an `Intent` subclass to trigger Parcel Creator Mismatch.
- action-controlled URI grant: `Intent.migrateExtraStreamToClipData()` inside `startActivity()` re-adds grant flags when the action is `ACTION_SEND`/`ACTION_SEND_MULTIPLE` or one of 5 image-capture actions, no ClipData is set, and extras are NOT in parcelled state — a freshly Binder-delivered or nested `getParcelable()`-extracted intent has parcelled extras and fails, while any `getXxxExtra()`/`putExtra()` unparcels them; `parseUri()`/`parseIntent()`-parsed intents satisfy it naturally; Android 18 restricts this.
- mutable PendingIntent URI grant: `PendingIntent.send()` with a `fillInIntent` pointing at your own package + data/clipdata target URI + grant flags, and a matching-action intent-filter in your own manifest — you gain read/write the moment it fires.
- `getCallingPackage()`/`getCallingActivity()` spoofing: they return the `setResult()` receiver, not the real starter — forge via `FLAG_ACTIVITY_FORWARD_RESULT` or `startIntentSenderForResult()`; fallback when the trusted app never starts you: implement an Autofill Service, set an IntentSender via `FillResponse.Builder.setAuthentication()` in `onFillRequest()`, and it fires inside the target app when the user taps a suggestion (needs user grant + interaction).
- TOCTOU after validation passes: the resolved target can still change — Self-changing Data Type (`getType()` callback returns a different mime), BadResolve (enable/disable components to alter resolution).
- `createPackageContext(attackerPkg, CONTEXT_INCLUDE_CODE | CONTEXT_IGNORE_SECURITY)` → code execution: set `android:appComponentFactory` in the PoC manifest; when the victim calls `context.getClassLoader()` the factory class is instantiated and its constructor runs.
