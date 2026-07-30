## Composite Exploit Chains

Prefer this matrix over single-pattern lookup. Pick the smallest chain that proves source, controlled object, sink, guard failure, and impact.

| Chain shape | High-signal code behavior | Load first |
|---|---|---|
| exported entry → Bundle/key mismatch → Intent redirect → private component | exported Activity/Service/Receiver validates one extra/key/object but later launches or returns a different caller-controlled `Intent`, component, selector, or flags | [[patterns/app_object-parsing]], [[patterns/app_intent-redirect]] |
| exported entry → Parcelable/Serializable parsing → auth/role confusion → protected sink | caller-controlled object field becomes role, package, account, command, file path, provider URI, or target before authorization | [[patterns/app_object-parsing]], [[patterns/app_exported-access]], [[patterns/app_service-cmd]] |
| provider traversal/data leak → URI grant/result leak → private file disclosure | Provider path/query/file handle is attacker-controlled and later exposed through `grantUriPermission`, `setResult`, or broad FileProvider roots | [[patterns/app_provider-leak]], [[patterns/app_uri-grant]], [[patterns/app_setresult-leak]] |
| provider `call`/batch/oracle → guard bypass → protected rows/action | `call()`, `applyBatch()`, `bulkInsert()`, or `getType()` reaches data/action not protected by the normal CRUD guard | [[patterns/app_provider-leak]] |
| WebView URL/deeplink → JS bridge → native component/provider sink | deep link, scan result, browser result, redirect, or HTML controls WebView script context that can invoke a native bridge method reaching component launch, provider, file, account, token, or command sink | [[patterns/app_webview-entry]], [[patterns/app_webview-exploit]], [[patterns/app_object-parsing]] |
| WebView file/cookie access → local/session data → exfiltration or bridge pivot | attacker-controlled WebView content can read local files/content or session cookies and move them through JS, bridge, network, or native callbacks | [[patterns/app_webview-exploit]], [[patterns/app_webview-entry]] |
| WebView intent scheme → Intent redirect → private component/grant | `intent://`, custom scheme, or `Intent.parseUri()` output is launched under app identity without target, selector, flag, or grant stripping | [[patterns/app_webview-exploit]], [[patterns/app_intent-redirect]], [[patterns/app_uri-grant]] |
| PendingIntent mutable/fill-in → victim identity action → URI grant/private component | caller-supplied, mutable, fill-in, replayable, or stored `PendingIntent` is dispatched as the victim app and carries attacker-controlled target, extras, flags, user-visible action, or grant | [[patterns/app_pendingintent]], [[patterns/app_intent-redirect]], [[patterns/app_uri-grant]] |
| ordered broadcast/service command → protected action → result/reply/notification leak | external action/extras, ordered broadcast mutation, Messenger, AIDL, or `onStartCommand()` reaches sensitive work and leaks through result, `replyTo`, notification, grant, or callback | [[patterns/app_broadcast]], [[patterns/app_service-cmd]], [[patterns/app_setresult-leak]] |
| task/fragment/UI pivot → credential/approval action → persisted state leak | external navigation chooses fragment, task, dialog, lifecycle state, or obscured UI and causes credential entry, approval, stale grant, or persisted sensitive state to move into attacker-relevant context | [[patterns/app_fragment-ui]], [[patterns/app_exported-access]] |

## Single Pattern Routing

Use this as fallback when the trace does not compose with another boundary. A route needs an entrypoint, controlled object, final sink, and guard/reject decision.

| Observed signal | Primary direction | Load first |
|---|---|---|
| exported Activity directly exposes private protected screen, action, or data | exported access | [[patterns/app_exported-access]] |
| nested Intent, `ClipData`, selector, or explicit component is forwarded | Intent redirect | [[patterns/app_intent-redirect]] |
| validated Bundle key differs from the key or object used by the sink | Bundle/key mismatch | [[patterns/app_object-parsing]] |
| fragment class/name comes from extras or URI | fragment injection | [[patterns/app_fragment-ui]] |
| path, filename, or URI reaches file APIs | path traversal | [[patterns/app_provider-leak]] |
| `setResult()` returns sensitive extras or grant-bearing URI | result leak | [[patterns/app_setresult-leak]] |
| caller-supplied or mutable `PendingIntent` reaches sensitive action | PendingIntent abuse | [[patterns/app_pendingintent]] |
| task affinity, launch mode, or obscured app-owned control leads to credential entry or protected in-app action | UI trust abuse | [[patterns/app_fragment-ui]] |
| lifecycle boundary preserves or continues sensitive resource/state into attacker-relevant context | lifecycle misuse | [[patterns/app_fragment-ui]] |
| dynamic receiver accepts external actions/extras that reach protected work | dynamic broadcast abuse | [[patterns/app_broadcast]] |
| ordered broadcast observation/modification/abort changes security outcome | ordered broadcast hijack | [[patterns/app_broadcast]] |
| weak custom permission gates a broadcast path with protected data/action | permission bypass | [[patterns/app_broadcast]] |
| global broadcast carries sensitive values | broadcast leak | [[patterns/app_broadcast]] |
| implicit Intent can be resolved by attacker and carries sensitive data, grant, or protected workflow | implicit Intent hijack | [[patterns/app_implicit-intent-hijack]] |
| app grants `content://` access to attacker-reachable flow | URI grant abuse | [[patterns/app_uri-grant]] |
| Serializable/Parcelable crosses trust boundary | object parsing abuse | [[patterns/app_object-parsing]] |
| exported Provider returns protected rows/files | provider data leak | [[patterns/app_provider-leak]] |
| SQL fragments include untrusted selection/path/order clauses | provider SQL injection | [[patterns/app_provider-leak]] |
| Provider path segments map to files | provider traversal | [[patterns/app_provider-leak]] |
| Provider `call()` performs privileged action | provider call exposure | [[patterns/app_provider-leak]] |
| `applyBatch()` / `bulkInsert()` skips per-operation checks | batch abuse | [[patterns/app_provider-leak]] |
| `getType()` oracle directly reveals protected state or enables a practical chain | provider oracle | [[patterns/app_provider-leak]] |
| FileProvider broad roots become attacker-reachable through grants/results/redirects | FileProvider misconfig | [[patterns/app_provider-leak]], [[patterns/app_uri-grant]] |
| exported/bindable Service exposes AIDL/Binder methods | AIDL / bound service | [[patterns/app_service-cmd]] |
| `Messenger` handler trusts `msg.what`, `Bundle`, or `replyTo` | Messenger abuse | [[patterns/app_service-cmd]] |
| foreground notification exposes sensitive values to attacker-observable surface | notification leak | [[patterns/app_service-cmd]] |
| WebView URL/HTML bypass reaches bridge, cookies, files, native scheme, or trusted session | URL validation bypass | [[patterns/app_webview-entry]], [[patterns/app_webview-exploit]] |
| WebView bridge or message channel exposes native method | JS bridge exposure | [[patterns/app_webview-exploit]] |
| file/content access is enabled for attacker-controlled WebView content | WebView file access | [[patterns/app_webview-exploit]] |
| SSL error handler proceeds and MITM content reaches meaningful WebView/native impact | WebView SSL bypass | [[patterns/app_webview-entry]] |
| authentication cookies reach attacker-controlled domain/content | cookie theft | [[patterns/app_webview-exploit]] |
| `intent://` or custom scheme launches native components | intent scheme injection | [[patterns/app_webview-exploit]] |
| QR/scan/browser result reaches WebView/native path and may pivot to bridge, cookie, file, scheme, or credential impact | scan-result source | [[patterns/app_webview-entry]] |
| app extracts zip/apk/jar, or dynamically loads DEX from external/untrusted path | archive extraction / dynamic loading | [[patterns/app_archive-extraction]] |
| app self-updates or loads plugin APK without integrity check | update/plugin injection | [[patterns/app_archive-extraction]] |
| exported Provider proxies queries to a more privileged provider | provider permission downgrade proxy | [[patterns/app_provider-leak]] |
| two Providers with different permissions share one SQLite database | provider database mixing | [[patterns/app_provider-leak]] |
| non-exported Provider has debug/admin action in `query()` branch | provider internal action exposure | [[patterns/app_provider-leak]] |
| app reads/writes clipboard, accessibility, notification, shared storage, or account manager with sensitive data | cross-app data channel | [[patterns/app_cross-app-channels]] |
| `AccountAuthenticator` returns caller-influenced Intent | Account Manager LaunchAnyWhere | [[patterns/app_cross-app-channels]], [[patterns/app_intent-redirect]] |
| `ACTION_SEND`/share target processes attacker URI/text/stream | share sheet entry | [[patterns/app_cross-app-channels]], [[patterns/app_provider-leak]] |
