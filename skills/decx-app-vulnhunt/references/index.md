# App Vulnerability Knowledge Base

Use references as a vulnerability knowledge base, not as a workflow manual. `SKILL.md` controls execution; this directory helps identify vulnerability shapes and route to the right reference.

## Layers

| Layer | Files | Purpose |
|---|---|---|
| Pattern cards | [[patterns/intent-redirect]], [[patterns/object-parsing]], [[patterns/webview-entry]], [[patterns/webview-exploit]], [[patterns/provider-leak]], [[patterns/archive-extraction]], [[patterns/cross-app-channels]] | route observed code to one vulnerability shape and constrain evidence/rejection rules |
| Rating | [[risk-rating]] | final report gate and severity authority |

## Load Order

1. Start with `Composite Exploit Chains` and pick the smallest chain that matches observed code behavior.
2. Load one or two matching pattern cards for source/sink/guard/reject rules. Do not load sibling cards by component name alone — only when the trace crosses that boundary.
3. Apply [[risk-rating]] before promoting any candidate to a finding.

Pattern cards should add one of three things: a routing signal, a non-obvious API quirk/version default, or a closed-form constraint that prevents false positives. Stop reading a card when it only repeats generic Android security knowledge.

## Composite Exploit Chains

Prefer this matrix over single-pattern lookup. Pick the smallest chain that proves source, controlled object, sink, guard failure, and impact.

| Chain shape | High-signal code behavior | Load first |
|---|---|---|
| exported entry → Bundle/key mismatch → Intent redirect → private component | exported Activity/Service/Receiver validates one extra/key/object but later launches or returns a different caller-controlled `Intent`, component, selector, or flags | [[patterns/object-parsing]], [[patterns/intent-redirect]] |
| exported entry → Parcelable/Serializable parsing → auth/role confusion → protected sink | caller-controlled object field becomes role, package, account, command, file path, provider URI, or target before authorization | [[patterns/object-parsing]], [[patterns/exported-access]], [[patterns/service-cmd]] |
| provider traversal/data leak → URI grant/result leak → private file disclosure | Provider path/query/file handle is attacker-controlled and later exposed through `grantUriPermission`, `setResult`, or broad FileProvider roots | [[patterns/provider-leak]], [[patterns/uri-grant]], [[patterns/setresult-leak]] |
| provider `call`/batch/oracle → guard bypass → protected rows/action | `call()`, `applyBatch()`, `bulkInsert()`, or `getType()` reaches data/action not protected by the normal CRUD guard | [[patterns/provider-leak]] |
| WebView URL/deeplink → JS bridge → native component/provider sink | deep link, scan result, browser result, redirect, or HTML controls WebView script context that can invoke a native bridge method reaching component launch, provider, file, account, token, or command sink | [[patterns/webview-entry]], [[patterns/webview-exploit]], [[patterns/object-parsing]] |
| WebView file/cookie access → local/session data → exfiltration or bridge pivot | attacker-controlled WebView content can read local files/content or session cookies and move them through JS, bridge, network, or native callbacks | [[patterns/webview-exploit]], [[patterns/webview-entry]] |
| WebView intent scheme → Intent redirect → private component/grant | `intent://`, custom scheme, or `Intent.parseUri()` output is launched under app identity without target, selector, flag, or grant stripping | [[patterns/webview-exploit]], [[patterns/intent-redirect]], [[patterns/uri-grant]] |
| PendingIntent mutable/fill-in → victim identity action → URI grant/private component | caller-supplied, mutable, fill-in, replayable, or stored `PendingIntent` is dispatched as the victim app and carries attacker-controlled target, extras, flags, user-visible action, or grant | [[patterns/pendingintent]], [[patterns/intent-redirect]], [[patterns/uri-grant]] |
| ordered broadcast/service command → protected action → result/reply/notification leak | external action/extras, ordered broadcast mutation, Messenger, AIDL, or `onStartCommand()` reaches sensitive work and leaks through result, `replyTo`, notification, grant, or callback | [[patterns/broadcast]], [[patterns/service-cmd]], [[patterns/setresult-leak]] |
| task/fragment/UI pivot → credential/approval action → persisted state leak | external navigation chooses fragment, task, dialog, lifecycle state, or obscured UI and causes credential entry, approval, stale grant, or persisted sensitive state to move into attacker-relevant context | [[patterns/fragment-ui]], [[patterns/exported-access]] |

## Single Pattern Routing

Use this as fallback when the trace does not compose with another boundary. A route needs an entrypoint, controlled object, final sink, and guard/reject decision.

| Observed signal | Primary direction | Load first |
|---|---|---|
| exported Activity directly exposes private protected screen, action, or data | exported access | [[patterns/exported-access]] |
| nested Intent, `ClipData`, selector, or explicit component is forwarded | Intent redirect | [[patterns/intent-redirect]] |
| validated Bundle key differs from the key or object used by the sink | Bundle/key mismatch | [[patterns/object-parsing]] |
| fragment class/name comes from extras or URI | fragment injection | [[patterns/fragment-ui]] |
| path, filename, or URI reaches file APIs | path traversal | [[patterns/provider-leak]] |
| `setResult()` returns sensitive extras or grant-bearing URI | result leak | [[patterns/setresult-leak]] |
| caller-supplied or mutable `PendingIntent` reaches sensitive action | PendingIntent abuse | [[patterns/pendingintent]] |
| task affinity, launch mode, or obscured app-owned control leads to credential entry or protected in-app action | UI trust abuse | [[patterns/fragment-ui]] |
| lifecycle boundary preserves or continues sensitive resource/state into attacker-relevant context | lifecycle misuse | [[patterns/fragment-ui]] |
| dynamic receiver accepts external actions/extras that reach protected work | dynamic broadcast abuse | [[patterns/broadcast]] |
| ordered broadcast observation/modification/abort changes security outcome | ordered broadcast hijack | [[patterns/broadcast]] |
| weak custom permission gates a broadcast path with protected data/action | permission bypass | [[patterns/broadcast]] |
| global broadcast carries sensitive values | broadcast leak | [[patterns/broadcast]] |
| implicit Intent can be resolved by attacker and carries sensitive data, grant, or protected workflow | implicit Intent hijack | [[patterns/implicit-intent-hijack]] |
| app grants `content://` access to attacker-reachable flow | URI grant abuse | [[patterns/uri-grant]] |
| Serializable/Parcelable crosses trust boundary | object parsing abuse | [[patterns/object-parsing]] |
| exported Provider returns protected rows/files | provider data leak | [[patterns/provider-leak]] |
| SQL fragments include untrusted selection/path/order clauses | provider SQL injection | [[patterns/provider-leak]] |
| Provider path segments map to files | provider traversal | [[patterns/provider-leak]] |
| Provider `call()` performs privileged action | provider call exposure | [[patterns/provider-leak]] |
| `applyBatch()` / `bulkInsert()` skips per-operation checks | batch abuse | [[patterns/provider-leak]] |
| `getType()` oracle directly reveals protected state or enables a practical chain | provider oracle | [[patterns/provider-leak]] |
| FileProvider broad roots become attacker-reachable through grants/results/redirects | FileProvider misconfig | [[patterns/provider-leak]], [[patterns/uri-grant]] |
| exported/bindable Service exposes AIDL/Binder methods | AIDL / bound service | [[patterns/service-cmd]] |
| `Messenger` handler trusts `msg.what`, `Bundle`, or `replyTo` | Messenger abuse | [[patterns/service-cmd]] |
| foreground notification exposes sensitive values to attacker-observable surface | notification leak | [[patterns/service-cmd]] |
| WebView URL/HTML bypass reaches bridge, cookies, files, native scheme, or trusted session | URL validation bypass | [[patterns/webview-entry]], [[patterns/webview-exploit]] |
| WebView bridge or message channel exposes native method | JS bridge exposure | [[patterns/webview-exploit]] |
| file/content access is enabled for attacker-controlled WebView content | WebView file access | [[patterns/webview-exploit]] |
| SSL error handler proceeds and MITM content reaches meaningful WebView/native impact | WebView SSL bypass | [[patterns/webview-entry]] |
| authentication cookies reach attacker-controlled domain/content | cookie theft | [[patterns/webview-exploit]] |
| `intent://` or custom scheme launches native components | intent scheme injection | [[patterns/webview-exploit]] |
| QR/scan/browser result reaches WebView/native path and may pivot to bridge, cookie, file, scheme, or credential impact | scan-result source | [[patterns/webview-entry]] |
| app extracts zip/apk/jar, or dynamically loads DEX from external/untrusted path | archive extraction / dynamic loading | [[patterns/archive-extraction]] |
| app self-updates or loads plugin APK without integrity check | update/plugin injection | [[patterns/archive-extraction]] |
| exported Provider proxies queries to a more privileged provider | provider permission downgrade proxy | [[patterns/provider-leak]] |
| two Providers with different permissions share one SQLite database | provider database mixing | [[patterns/provider-leak]] |
| non-exported Provider has debug/admin action in `query()` branch | provider internal action exposure | [[patterns/provider-leak]] |
| app reads/writes clipboard, accessibility, notification, shared storage, or account manager with sensitive data | cross-app data channel | [[patterns/cross-app-channels]] |
| `AccountAuthenticator` returns caller-influenced Intent | Account Manager LaunchAnyWhere | [[patterns/cross-app-channels]], [[patterns/intent-redirect]] |
| `ACTION_SEND`/share target processes attacker URI/text/stream | share sheet entry | [[patterns/cross-app-channels]], [[patterns/provider-leak]] |
