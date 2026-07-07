# DECX Compact Knowledge Index

Use this index to load the smallest useful knowledge topic. Knowledge is a lead; accepted facts still require DECX/tool/file evidence.

| Topic | Load when | Source basis |
|---|---|---|
| `app` | APK, exported component, provider, WebView, PendingIntent, broadcast, URI grant, object parsing, archive loading, or cross-app channel analysis | `skills/decx-app-vulnhunt/references` |
| `framework` | Android framework service, Binder, system identity, cross-user, PendingIntent, provider proxy, transition, race, validation gap, or native service analysis | `skills/decx-framework-vulnhunt/references` |
| `evidence` | Candidate promotion, finding gate, severity, report confidence, or rejection decision | app/framework risk-rating references |
| `poc_report` | Building PoC or report from accepted graph facts | `skills/decx-poc/references`, `skills/decx-report/references` |

Loading rule: choose one topic, use it to form one bounded intent or verdict, then return to graph evidence.
