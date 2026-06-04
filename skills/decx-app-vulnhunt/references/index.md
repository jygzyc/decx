# App Vulnerability Knowledge Base

Use references as a vulnerability knowledge base, not as a workflow manual. `SKILL.md` controls execution; this directory helps identify vulnerability shapes and route to the right reference.

## Layers

| Layer | Files | Purpose |
|---|---|---|
| Component overviews | [[overviews/activity]], [[overviews/service]], [[overviews/broadcast]], [[overviews/provider]], [[overviews/webview]], [[overviews/intent]] | map entrypoints, sources, sinks, probing questions, and chain pivots |
| Pattern cards | [[patterns/intent-redirect]], [[patterns/provider-data-leak]], [[patterns/webview-url-bypass]] | define core concept, guards, rejection, and rating rules for a vulnerability shape |
| Casebooks | [[casebooks/intent-redirect-cases]], [[casebooks/provider-cases]], [[casebooks/webview-cases]] | preserve public-case knowledge as abstract exploit-chain shapes |
| Rating | [[risk-rating]] | final report gate and severity authority |

## Load Order

1. Start with `Composite Exploit Chains` and pick the smallest chain that matches observed code behavior.
2. Load one component overview when entrypoint context matters.
3. Load one or two matching pattern cards for source/sink/guard/reject rules. Do not load sibling cards by component name alone — only when the trace crosses that boundary.
4. Load a casebook only when a chain needs comparable exploit-shape examples.
5. Use `Single Pattern Routing` only when the trace is clearly a standalone bug.
6. Apply [[risk-rating]] before promoting any candidate to a finding.

## Composite Exploit Chains

Prefer this matrix over single-pattern lookup. A reportable app bug usually crosses at least one boundary: external entry to internal component, WebView to native, provider to file/grant, object parser to protected sink, or caller identity to victim identity.

| Chain shape | High-signal code behavior | Load first |
|---|---|---|
| exported entry -> intent redirect -> private component / URI grant | exported Activity/Service/Receiver extracts nested `Intent`, selector, `ClipData`, flags, or component and forwards or returns it | [[overviews/activity]], [[patterns/intent-redirect]], [[patterns/uri-grant-leak]], [[casebooks/intent-redirect-cases]] |
| WebView URL bypass -> JS bridge / cookie / file access / native scheme | deep link, scan result, browser result, or redirect controls WebView content that can invoke bridge, read cookies/files, or launch native schemes | [[overviews/webview]], [[patterns/webview-url-bypass]], [[patterns/webview-js-bridge]], [[patterns/webview-cookie-theft]], [[patterns/webview-file-access]], [[patterns/webview-intent-scheme]], [[casebooks/webview-cases]] |
| provider traversal / data leak -> grant or result leak | Provider path/query/file handle is attacker-controlled and later exposed through `grantUriPermission`, `setResult`, or broad FileProvider roots | [[overviews/provider]], [[patterns/provider-path-traversal]], [[patterns/provider-data-leak]], [[patterns/uri-grant-leak]], [[patterns/setresult-leak]], [[casebooks/provider-cases]], [[casebooks/uri-grant-cases]] |
| object parsing -> auth bypass -> protected sink | `Serializable`, `Parcelable`, `Bundle`, JSON, or URI object controls identity, role, target, command, or file/provider argument before authorization | [[patterns/object-parsing-abuse]], [[patterns/exported-access]], [[patterns/service-command-injection]], [[casebooks/object-parsing-cases]] |
| PendingIntent -> victim identity action -> private component/data grant | caller-supplied, mutable, fill-in, or replayable `PendingIntent` is used to act as the victim app or to reach a protected target | [[patterns/pendingintent-abuse]], [[patterns/intent-redirect]], [[patterns/uri-grant-leak]], [[casebooks/pendingintent-cases]] |
| broadcast/service command -> protected action -> result/grant leak | external action/extras, ordered broadcast, Messenger, or AIDL dispatch reaches sensitive work and leaks through result, reply, notification, or grant | [[overviews/broadcast]], [[overviews/service]], [[patterns/broadcast-abuse]], [[patterns/service-command-injection]], [[patterns/setresult-leak]], [[casebooks/broadcast-cases]], [[casebooks/service-cases]] |
| UI/fragment trust pivot -> credential or privileged in-app action | external navigation chooses fragment/task/UI state and tricks user or app logic into privileged authenticated action | [[overviews/activity]], [[patterns/fragment-injection]], [[patterns/ui-trust-abuse]], [[patterns/lifecycle-state-exposure]], [[casebooks/fragment-ui-cases]], [[casebooks/lifecycle-cases]] |

## Single Pattern Routing

Use this as fallback when the trace does not compose with another boundary. If a signal only names an entrypoint, keep tracing until you can name the controlled value, downstream boundary, sink, and guard.

| Observed signal | Primary direction | Load first |
|---|---|---|
| exported Activity directly exposes private protected screen, action, or data | exported access | [[patterns/exported-access]] |
| nested Intent, `ClipData`, selector, or explicit component is forwarded | Intent redirect | [[patterns/intent-redirect]], then [[casebooks/intent-redirect-cases]] if needed |
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
