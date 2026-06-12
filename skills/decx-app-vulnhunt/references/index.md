# App Vulnerability Knowledge Base

Use references as a vulnerability knowledge base, not as a workflow manual. `SKILL.md` controls execution; this directory helps identify vulnerability shapes and route to the right reference.

## Layers

| Layer | Files | Purpose |
|---|---|---|
| Component overviews | [[overviews/activity]], [[overviews/service]], [[overviews/broadcast]], [[overviews/provider]], [[overviews/webview]], [[overviews/intent]] | map entrypoints, sources, sinks, probing questions, and chain pivots |
| Pattern cards | [[patterns/intent-redirect]], [[patterns/provider-data-leak]], [[patterns/webview-url-bypass]] | route observed code to one vulnerability shape and constrain evidence/rejection rules |
| Casebooks | [[casebooks/intent-redirect-cases]], [[casebooks/provider-cases]], [[casebooks/webview-cases]] | preserve public-case knowledge as abstract exploit-chain shapes |
| Rating | [[risk-rating]] | final report gate and severity authority |

## Load Order

1. Start with `Composite Exploit Chains` and pick the smallest chain that matches observed code behavior.
2. Load one component overview when entrypoint context matters.
3. Load one or two matching pattern cards for source/sink/guard/reject rules. Do not load sibling cards by component name alone — only when the trace crosses that boundary.
4. Load a casebook only when a chain needs comparable exploit-shape examples.
5. Use `Single Pattern Routing` only when the trace is clearly a standalone bug.
6. Apply [[risk-rating]] before promoting any candidate to a finding.

Pattern cards should add one of three things: a routing signal, a project/casebook-specific trace cue, or a closed-form constraint that prevents false positives. Stop reading a card when it only repeats generic Android security knowledge.

## Composite Exploit Chains

Prefer this matrix over single-pattern lookup. Pick the smallest chain that proves source, controlled object, sink, guard failure, and impact.

| Chain shape | High-signal code behavior | Load first |
|---|---|---|
| exported entry -> Bundle/key mismatch -> Intent redirect -> private component | exported Activity/Service/Receiver validates one extra/key/object but later launches or returns a different caller-controlled `Intent`, component, selector, or flags | [[overviews/activity]], [[overviews/intent]], [[patterns/object-parsing-abuse]], [[patterns/intent-redirect]], [[casebooks/object-parsing-cases]], [[casebooks/intent-redirect-cases]] |
| exported entry -> Parcelable/Serializable parsing -> auth/role confusion -> protected sink | caller-controlled object field becomes role, package, account, command, file path, provider URI, or target before authorization | [[patterns/object-parsing-abuse]], [[patterns/exported-access]], [[patterns/service-command-injection]], [[casebooks/object-parsing-cases]] |
| provider traversal/data leak -> URI grant/result leak -> private file disclosure | Provider path/query/file handle is attacker-controlled and later exposed through `grantUriPermission`, `setResult`, or broad FileProvider roots | [[overviews/provider]], [[patterns/provider-path-traversal]], [[patterns/provider-data-leak]], [[patterns/uri-grant-leak]], [[patterns/setresult-leak]], [[casebooks/provider-cases]], [[casebooks/uri-grant-cases]] |
| provider `call`/batch/oracle -> guard bypass -> protected rows/action | `call()`, `applyBatch()`, `bulkInsert()`, or `getType()` reaches data/action not protected by the normal CRUD guard | [[overviews/provider]], [[patterns/provider-data-leak]], [[patterns/provider-sql-injection]], [[casebooks/provider-cases]] |
| WebView URL/deeplink -> JS bridge -> native component/provider sink | deep link, scan result, browser result, redirect, or HTML controls WebView script context that can invoke a native bridge method reaching component launch, provider, file, account, token, or command sink | [[overviews/webview]], [[patterns/webview-url-bypass]], [[patterns/webview-js-bridge]], [[patterns/object-parsing-abuse]], [[casebooks/webview-cases]] |
| WebView file/cookie access -> local/session data -> exfiltration or bridge pivot | attacker-controlled WebView content can read local files/content or session cookies and move them through JS, bridge, network, or native callbacks | [[patterns/webview-file-access]], [[patterns/webview-cookie-theft]], [[patterns/webview-url-bypass]], [[casebooks/webview-cases]] |
| WebView intent scheme -> Intent redirect -> private component/grant | `intent://`, custom scheme, or `Intent.parseUri()` output is launched under app identity without target, selector, flag, or grant stripping | [[patterns/webview-intent-scheme]], [[patterns/intent-redirect]], [[patterns/uri-grant-leak]], [[casebooks/webview-cases]], [[casebooks/intent-redirect-cases]] |
| PendingIntent mutable/fill-in -> victim identity action -> URI grant/private component | caller-supplied, mutable, fill-in, replayable, or stored `PendingIntent` is dispatched as the victim app and carries attacker-controlled target, extras, flags, user-visible action, or grant | [[patterns/pendingintent-abuse]], [[patterns/intent-redirect]], [[patterns/uri-grant-leak]], [[casebooks/pendingintent-cases]] |
| ordered broadcast/service command -> protected action -> result/reply/notification leak | external action/extras, ordered broadcast mutation, Messenger, AIDL, or `onStartCommand()` reaches sensitive work and leaks through result, `replyTo`, notification, grant, or callback | [[overviews/broadcast]], [[overviews/service]], [[patterns/broadcast-abuse]], [[patterns/service-command-injection]], [[patterns/setresult-leak]], [[casebooks/broadcast-cases]], [[casebooks/service-cases]] |
| task/fragment/UI pivot -> credential/approval action -> persisted state leak | external navigation chooses fragment, task, dialog, lifecycle state, or obscured UI and causes credential entry, approval, stale grant, or persisted sensitive state to move into attacker-relevant context | [[overviews/activity]], [[patterns/fragment-injection]], [[patterns/ui-trust-abuse]], [[patterns/lifecycle-state-exposure]], [[casebooks/fragment-ui-cases]], [[casebooks/lifecycle-cases]] |

## Single Pattern Routing

Use this as fallback when the trace does not compose with another boundary. A route needs an entrypoint, controlled object, final sink, and guard/reject decision.

| Observed signal | Primary direction | Load first |
|---|---|---|
| exported Activity directly exposes private protected screen, action, or data | exported access | [[patterns/exported-access]] |
| nested Intent, `ClipData`, selector, or explicit component is forwarded | Intent redirect | [[patterns/intent-redirect]], then [[casebooks/intent-redirect-cases]] if needed |
| validated Bundle key differs from the key or object used by the sink | Bundle/key mismatch | [[patterns/object-parsing-abuse]], then [[casebooks/object-parsing-cases]] |
| fragment class/name comes from extras or URI | fragment injection | [[patterns/fragment-injection]] |
| path, filename, or URI reaches file APIs | path traversal | [[patterns/provider-path-traversal]], then component variant if needed |
| `setResult()` returns sensitive extras or grant-bearing URI | result leak | [[patterns/setresult-leak]] |
| caller-supplied or mutable `PendingIntent` reaches sensitive action | PendingIntent abuse | [[patterns/pendingintent-abuse]] |
| task affinity, launch mode, or obscured app-owned control leads to credential entry or protected in-app action | UI trust abuse | [[patterns/ui-trust-abuse]] |
| lifecycle boundary preserves or continues sensitive resource/state into attacker-relevant context | lifecycle misuse | [[patterns/lifecycle-state-exposure]] |
| dynamic receiver accepts external actions/extras that reach protected work | dynamic broadcast abuse | [[patterns/broadcast-abuse]] |
| ordered broadcast observation/modification/abort changes security outcome | ordered broadcast hijack | [[patterns/broadcast-abuse]] |
| weak custom permission gates a broadcast path with protected data/action | permission bypass | [[patterns/broadcast-abuse]] |
| global broadcast carries sensitive values | broadcast leak | [[patterns/broadcast-abuse]] |
| implicit Intent can be resolved by attacker and carries sensitive data, grant, or protected workflow | implicit Intent hijack | [[patterns/implicit-intent-hijack]] |
| app grants `content://` access to attacker-reachable flow | URI grant abuse | [[patterns/uri-grant-leak]] |
| Serializable/Parcelable crosses trust boundary | object parsing abuse | [[patterns/object-parsing-abuse]] |
| exported Provider returns protected rows/files | provider data leak | [[patterns/provider-data-leak]] |
| SQL fragments include untrusted selection/path/order clauses | provider SQL injection | [[patterns/provider-sql-injection]], then [[casebooks/provider-cases]] if needed |
| Provider path segments map to files | provider traversal | [[patterns/provider-path-traversal]], then [[casebooks/provider-cases]] if needed |
| Provider `call()` performs privileged action | provider call exposure | [[patterns/provider-data-leak]] |
| `applyBatch()` / `bulkInsert()` skips per-operation checks | batch abuse | [[patterns/provider-data-leak]] |
| `getType()` oracle directly reveals protected state or enables a practical chain | provider oracle | [[patterns/provider-data-leak]] |
| FileProvider broad roots become attacker-reachable through grants/results/redirects | FileProvider misconfig | [[patterns/uri-grant-leak]], [[patterns/provider-path-traversal]] |
| exported/bindable Service exposes AIDL/Binder methods | AIDL / bound service | [[patterns/service-command-injection]] |
| Service `onStartCommand()` dispatches extras/actions to sensitive work | service command injection | [[patterns/service-command-injection]] |
| `Messenger` handler trusts `msg.what`, `Bundle`, or `replyTo` | Messenger abuse | [[patterns/service-command-injection]] |
| foreground notification exposes sensitive values to attacker-observable surface | notification leak | [[patterns/service-command-injection]] |
| WebView URL/HTML bypass reaches bridge, cookies, files, native scheme, or trusted session | URL validation bypass | [[patterns/webview-url-bypass]] |
| WebView bridge or message channel exposes native method | JS bridge exposure | [[patterns/webview-js-bridge]], then [[casebooks/webview-cases]] if needed |
| file/content access is enabled for attacker-controlled WebView content | WebView file access | [[patterns/webview-file-access]], then [[casebooks/webview-cases]] if needed |
| SSL error handler proceeds and MITM content reaches meaningful WebView/native impact | WebView SSL bypass | [[patterns/webview-ssl-bypass]] |
| authentication cookies reach attacker-controlled domain/content | cookie theft | [[patterns/webview-cookie-theft]] |
| `intent://` or custom scheme launches native components | intent scheme injection | [[patterns/webview-intent-scheme]] |
| QR/scan/browser result reaches WebView/native path and may pivot to bridge, cookie, file, scheme, or credential impact | scan-result source | [[patterns/webview-scan-result-injection]] |

## Casebooks

| Casebook | Linked patterns |
|---|---|
| [[casebooks/intent-redirect-cases]] | [[patterns/intent-redirect]], [[patterns/implicit-intent-hijack]], [[patterns/uri-grant-leak]] |
| [[casebooks/provider-cases]] | [[patterns/provider-data-leak]], [[patterns/provider-path-traversal]], [[patterns/provider-sql-injection]] |
| [[casebooks/webview-cases]] | [[patterns/webview-url-bypass]], [[patterns/webview-js-bridge]], [[patterns/webview-file-access]], [[patterns/webview-cookie-theft]], [[patterns/webview-ssl-bypass]] |
| [[casebooks/broadcast-cases]] | [[patterns/broadcast-abuse]] |
| [[casebooks/pendingintent-cases]] | [[patterns/pendingintent-abuse]], [[patterns/intent-redirect]] |
| [[casebooks/service-cases]] | [[patterns/service-command-injection]], [[patterns/object-parsing-abuse]] |
| [[casebooks/uri-grant-cases]] | [[patterns/uri-grant-leak]], [[patterns/setresult-leak]], [[patterns/provider-path-traversal]] |
| [[casebooks/fragment-ui-cases]] | [[patterns/fragment-injection]], [[patterns/ui-trust-abuse]] |
| [[casebooks/lifecycle-cases]] | [[patterns/lifecycle-state-exposure]] |
| [[casebooks/object-parsing-cases]] | [[patterns/object-parsing-abuse]], [[patterns/exported-access]], [[patterns/service-command-injection]] |
