# Pattern: Exported Access

## Match

Two implicit-export behaviors raise the priority sharply:
1. On API < 17 (or any API for Activity/Service/Receiver with `<intent-filter>`), absence of `android:exported` defaults to `true`. On API 31+ a component with `<intent-filter>` MUST declare `android:exported` explicitly; otherwise the install is rejected.
2. Provider export default flips at API 17: `< 17` defaults `exported="true"`, `>= 17` defaults `false`. Audit older Provider rules carefully.

A separate export primitive: a non-exported but `<intent-filter>`-bearing Activity that is reachable through an Intent-redirect or Bundle-mismatch path. That belongs to `intent-redirect` / `object-parsing-abuse` and feeds into this pattern as a downstream sink.

## Analyze

- entry: manifest export, implicit export (intent-filter without `android:exported`), deep link `<data android:scheme=...>`, dynamic receiver, bindable service, grant/proxy path
- control: action/extras/URI/path/command/identity selected by external caller, deep-link query parameters, grant flags, request code
- sink: protected UI/action/data, provider/file access, service command, account/session state, internal non-exported component reached via the export
- guard: `signature` permission, package/UID binding (`Binder.getCallingUid()`), on API 31+ explicit `android:exported="true"` only when intentional
- impact: protected workflow, data exposure, private component reachability, or chain entry into redirect/provider/WebView/service

## Reject

Reject when behavior is public/harmless, permission gates exact sink, caller cannot control any security-relevant value, downstream impact absent, or the reachable path is a confirmation dialog with its own coverage.

## Codes

```java
// onBind without caller check — bindable service implicit export
return downloadServiceHandler.onBind(intent);
```

```java
// non-exported handler reachable via redirect — redirect lives in intent-redirect / object-parsing-abuse
```
