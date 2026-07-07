# PoC and Report Routing

## PoC construction

Use only accepted facts as inputs. A PoC intent should request the minimum artifact that verifies the accepted chain:

- Activity/deep-link/intent redirect: build launcher intent with exact extras, data URI, flags, and component.
- Broadcast: send explicit action/extras and capture result or side effect.
- Service/AIDL/Messenger: bind or start with exact command/message fields and observe reply, callback, notification, or state change.
- Provider: query/open/call/applyBatch with exact URI, projection, selection, sort, path, or grant setup.
- WebView: serve minimal HTML/URL or intent scheme that reaches accepted bridge/file/cookie/native sink.
- Framework service: use shell/app/Binder harness matching accepted caller identity and user/profile assumptions.

A PoC cannot introduce new vulnerability claims. If implementation needs unaccepted assumptions, Planner must create new intents first.

## Report construction

Report from accepted graph chains only. Each finding needs:

- Summary and affected surface.
- Evidence chain with Fact/Intent IDs.
- Reproduction or PoC path if available.
- Visible impact.
- Rating rationale.
- Preconditions and uncertainties.
- Rejection notes for near misses when useful.

Do not duplicate report templates in analysis roles; load this topic only when producing PoC/report artifacts.
