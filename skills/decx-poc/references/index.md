# PoC Reference Routing

Use after `poc-spec.md` is complete. Select exactly one primary reference.

## Input

Findings are finalized analysis writeups from `decx-vulnhunt`.

## Load Order

1. `poc-spec.md`
2. `poc-base.md`
3. one primary surface reference from the matrix below

## Routing Matrix

| Spec signal | PoC shape | Load |
|---|---|---|
| exported Activity, result capture, task/UI/lifecycle | `direct-trigger`, `returned-handle`, `ui-assisted` | [[poc-app-activity]] |
| Broadcast/Receiver send, ordered interception, global leak | `direct-trigger`, `interception` | [[poc-app-broadcast]] |
| Provider query/file/call/batch/grant | `direct-trigger`, `returned-handle` | [[poc-app-provider]] |
| Service start/bind/Messenger/AIDL | `direct-trigger`, `binder-caller` | [[poc-app-service]] |
| PendingIntent, URI grant, implicit Intent, parcel/classloader | `returned-handle`, `interception`, `direct-trigger` | [[poc-app-intent]] |
| WebView deep link / hosted payload | `scenario-page` | [[poc-app-webview]] |
| Framework Binder/system service | `binder-caller` | [[poc-framework-service]] |

## Cross-Reference Rules

- PendingIntent/URI grant/implicit Intent → prefer [[poc-app-intent]] even if delivered by another component.
- Task/UI/lifecycle → prefer [[poc-app-activity]].
- Framework Binder → [[poc-framework-service]] only.
