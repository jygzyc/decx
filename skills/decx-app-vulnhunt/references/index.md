# App Vulnerability References

Use references as a vulnerability knowledge base, not as a second workflow manual. `SKILL.md` controls execution; this directory helps identify vulnerability shapes.

## Layers

| Layer | Files | Purpose |
|---|---|---|
| Component overviews | `overviews/*.md` | map entrypoints, sources, sinks, and which pattern to load |
| Pattern cards | `patterns/*.md` | define source/sink/guard/evidence/rejection/rating rules for a vulnerability shape |
| Casebooks | `casebooks/*.md` | preserve real-case knowledge as abstract exploit-chain shapes |
| Rating | `risk-rating.md` | final report gate and severity authority |

## Load Order

1. Start with `vulnerability-router.md` or the relevant `overviews/*.md` component map.
2. Load only the smallest matching pattern card.
3. Use casebooks only when a pattern needs concrete exploit-shape examples.
4. Use `risk-rating.md` before promoting any candidate to a finding.

## Coverage Matrix

| Knowledge area | Canonical pattern |
|---|---|
| exported Activity/Service/Receiver/Provider direct access | `patterns/exported-access.md` |
| nested Intent, selector, component, target package, WebView native dispatch | `patterns/intent-redirect.md`, `patterns/webview-intent-scheme.md` |
| implicit Intent capture | `patterns/implicit-intent-hijack.md` |
| PendingIntent creation, mutation, fill-in, victim identity reuse | `patterns/pendingintent-abuse.md` |
| URI grants, ClipData grants, FileProvider grant leaks | `patterns/uri-grant-leak.md` |
| Activity result leaks | `patterns/setresult-leak.md` |
| fragment route/class injection | `patterns/fragment-injection.md` |
| task hijack, clickjacking, trusted UI confusion | `patterns/ui-trust-abuse.md` |
| lifecycle stale state, stale grants/results, continued sensitive work | `patterns/lifecycle-state-exposure.md` |
| dynamic/static/ordered/global broadcast abuse | `patterns/broadcast-abuse.md` |
| AIDL, Binder, Messenger, started/bound service command abuse | `patterns/service-command-injection.md` |
| Parcelable, Serializable, Bundle, classloader, parser mismatch | `patterns/object-parsing-abuse.md` |
| provider data/call/batch/getType/FileProvider exposure | `patterns/provider-data-leak.md` |
| provider/file path traversal | `patterns/provider-path-traversal.md` |
| provider SQL control | `patterns/provider-sql-injection.md` |
| WebView URL validation bypass and scan/browser result injection | `patterns/webview-url-bypass.md`, `patterns/webview-scan-result-injection.md` |
| WebView bridge/message exposure | `patterns/webview-js-bridge.md` |
| WebView file/content access | `patterns/webview-file-access.md` |
| WebView cookie/session exposure | `patterns/webview-cookie-theft.md` |
| WebView SSL error bypass | `patterns/webview-ssl-bypass.md` |

## Casebooks

| Casebook | Linked patterns |
|---|---|
| `casebooks/intent-redirect-cases.md` | `patterns/intent-redirect.md` |
| `casebooks/provider-cases.md` | `patterns/provider-data-leak.md`, `patterns/provider-path-traversal.md`, `patterns/provider-sql-injection.md` |
| `casebooks/webview-cases.md` | `patterns/webview-url-bypass.md`, `patterns/webview-js-bridge.md`, `patterns/webview-file-access.md` |
