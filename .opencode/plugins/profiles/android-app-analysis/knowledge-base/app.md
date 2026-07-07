# Android App Vulnerability Routing

## Exploitability gate

A finding needs all four: reachable entry, attacker-controlled security input, deep trace to sink or blocker, and visible impact. Missing one means candidate or dead end, not finding.

## Composite chains first

| Chain | Signal | Primary checks |
|---|---|---|
| Exported entry -> object/key mismatch -> intent redirect -> private component | Validates one extra but launches/returns another caller-controlled Intent, component, selector, flags, or ClipData | exact controlled field, dangerous field stripping, downstream protection |
| Parcelable/Serializable -> role/package/path confusion -> protected sink | Caller object field becomes role, package, account, command, file path, URI, or target | class loader, CREATOR side effects, authorization before use |
| Provider leak/traversal -> URI grant/result leak -> private data | Provider path/query/file handle is attacker-controlled and then exposed through result, grant, or broad FileProvider root | method-specific guard, normalize/confine path, grant flags |
| Provider call/batch/oracle -> guard skew -> protected action | `call`, `applyBatch`, `bulkInsert`, or `getType` reaches data/action not protected like CRUD | per-method permission skew and oracle usefulness |
| WebView/deep link -> JS bridge -> native sink | External URL/HTML controls bridge or scheme reaching component, provider, file, token, command, or account sink | URL trust boundary, bridge exposure, cookie/file access |
| WebView intent scheme -> intent redirect -> grant/private component | `intent://`, custom scheme, or `Intent.parseUri` is launched under app identity | strip component/package/selector/ClipData/FLAG_GRANT_* |
| Mutable PendingIntent/fill-in -> victim identity action | Caller controls target, extras, flags, request code, grant, or replay of victim-sent PendingIntent | mutability flags, fill-in fields, identity of sender |
| Broadcast/service command -> protected action -> result/reply leak | External action/extras, ordered broadcast mutation, Messenger, AIDL, or `onStartCommand` reaches sensitive work | permission, `replyTo`, result, notification, callback leak |
| Fragment/task/UI pivot -> credential or approval action | External navigation chooses fragment/task/dialog/lifecycle state or obscured UI | user confirmation, lifecycle persistence, sensitive state movement |
| Task/window embedding -> intent or result sniffing | External launch or embedding path lets an attacker observe task state, result, or sensitive Intent data | task/fragment controller, launch mode, result channel, captured data |

## High-signal single-pattern routing

- Intent redirect: forwarded Intent/Uri/ClipData/selector/component/package/flags; package equality alone is not enough because component has precedence.
- Object parsing: Bundle key mismatch, Parcelable/Serializable crossing trust boundary, unsafe class loader, field later used as authority.
- Provider leak: exported or grant-reachable provider returns protected data/FD/MIME, builds SQL fragments, decodes path segments, or proxies attacker URI.
- URI grant/result leak: `setResult`, `grantUriPermission`, persistable grants, or FileProvider broad roots expose app-readable data.
- WebView: URL validation bypass, SSL proceed, bridge/message channel exposure, file/content access, cookie movement, intent-scheme launch.
- PendingIntent: mutable/fill-in/replayable/stored PendingIntent dispatched as victim app.
- Broadcast/service: dynamic receiver, ordered broadcast, weak custom permission, Messenger command, AIDL/bound service, notification leak.
- Archive/dynamic loading: untrusted zip/apk/jar/dex extraction or plugin update without integrity check.
- Cross-app channels: clipboard, accessibility, notification, shared storage, AccountManager, share sheet URI/text/stream.
- Bundle or Parcel mismatch: the object checked by a guard differs from the object later executed after unparcel, reserialize, or nested-Intent extraction.
- TaskFragment or task hijack: task embedding, activity result, recents/task affinity, or fragment navigation lets another app infer or capture sensitive Intent/result content.

## IMA-derived leads to prioritize

- Treat LaunchAnyWhere-style bugs as validation-equivalence bugs, not just missing checks. Prove whether the exact nested Intent, Bundle key, selector, component, ClipData, URI grant, and flags that are validated are the same values later launched or returned.
- For task and window flows, do not stop at exported-component reachability. Check whether the attacker can shape task placement, embedding, result delivery, or navigation state to observe data without holding the victim permission.
- For Parcel-heavy flows, add a reserialization checkpoint: if the app validates an object before Binder, storage, or callback round-trips, verify the same semantic object reaches the sink.

## Rejection rules

Reject when the exact sink path is rebuilt from trusted constants, dangerous fields are stripped, non-bypassable guard covers the exact method, write-only state has no readback or impact, path is normalized and confined, or impact is only crash/compatibility.
