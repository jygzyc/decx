# PoC Reference Routing

Use after `poc-spec.md` is complete. Select exactly one primary reference.

The matrix below is the Android harness set (`android-poc-*.md`); a second target adds its own section and its own `<target>-poc-*.md` files.

## Input

Findings are finalized analysis writeups from `decx-vulnhunt`.

## Load Order

1. `poc-spec.md`
2. `android-poc-base.md`
3. one primary surface reference from the matrix below

## Routing Matrix

| Spec signal | PoC shape | Load |
|---|---|---|
| exported Activity, result capture, task/UI/lifecycle | `direct-trigger`, `returned-handle`, `ui-assisted` | [[android-poc-activity]] |
| Broadcast/Receiver send, ordered interception, global leak | `direct-trigger`, `interception` | [[android-poc-broadcast]] |
| Provider query/file/call/batch/grant | `direct-trigger`, `returned-handle` | [[android-poc-provider]] |
| Service start/bind/Messenger/AIDL | `direct-trigger`, `binder-caller` | [[android-poc-service]] |
| PendingIntent, URI grant, implicit Intent, parcel/classloader | `returned-handle`, `interception`, `direct-trigger` | [[android-poc-intent]] |
| WebView deep link / hosted payload | `scenario-page` | [[android-poc-webview]] |
| Framework Binder/system service | `binder-caller` | [[android-poc-framework-service]] |

## Cross-Reference Rules

- PendingIntent/URI grant/implicit Intent → prefer [[android-poc-intent]] even if delivered by another component.
- Task/UI/lifecycle → prefer [[android-poc-activity]].
- Framework Binder → [[android-poc-framework-service]] only.
