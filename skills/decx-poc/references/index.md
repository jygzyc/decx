# PoC Reference Routing

Use references to select the right PoC construction pattern for a given finding surface. `SKILL.md` controls workflow; this directory helps identify the exploit shape and wire the correct template.

## Upstream Sources

Findings come from two vulnhunt skills via the shared `decx-analysis-db.mjs` blackboard CLI (located in `scripts/`):

| Target kind | Upstream skill | Target type | Session open command |
|---|---|---|---|
| App (facts with `entrypoint:` prefix) | `decx-app-vulnhunt` | APK | `decx process open "<apk>"` |
| Framework (facts with `service-entrypoint:` prefix) | `decx-framework-vulnhunt` | Framework JAR | `decx ard framework open "<jar>"` |

Determine the target kind from fact description prefixes before selecting a reference.

## Layers

| Layer | File | Purpose |
|---|---|---|
| Shared contract | [[poc-base]] | registration shape, success signals, support components, common rules |
| Workflow | [[poc-workflow]] | XML contract, re-verification, compile/deploy, final output format |
| App Activity | [[poc-app-activity]] | exported access, intent redirect, fragment injection, path traversal, PendingIntent abuse, result leak, task hijack, clickjacking, lifecycle |
| App Broadcast | [[poc-app-broadcast]] | dynamic receiver abuse, ordered-broadcast hijack, permission bypass, global broadcast leakage |
| App Provider | [[poc-app-provider]] | data exposure, SQL injection, path traversal, custom call, batch abuse, getType oracle, FileProvider misconfig |
| App Service | [[poc-app-service]] | AIDL exposure, Messenger abuse, Intent injection, bind escalation, foreground-notification leakage |
| App Intent | [[poc-app-intent]] | mutable PendingIntent abuse, URI-grant abuse, implicit Intent hijack, ClassLoader injection, parcel mismatch |
| App WebView | [[poc-app-webview]] | deep-link to WebView sink, URL-parameter injection, hosted payload |
| Framework Service | [[poc-framework-service]] | clearCallingIdentity misuse, missing permission enforcement, identity confusion, intent redirect, data exposure, race conditions |

## Routing Matrix

Select one primary reference based on the finding's attack surface and PoC shape:

| Finding surface | PoC shape | Reference |
|---|---|---|
| exported Activity (direct launch, result capture) | `direct-trigger`, `ui-assisted` | [[poc-app-activity]] |
| exported Broadcast / Receiver | `direct-trigger`, `interception` | [[poc-app-broadcast]] |
| exported Provider (query, file, call, batch) | `direct-trigger`, `returned-handle` | [[poc-app-provider]] |
| exported or bindable Service | `direct-trigger`, `binder-caller` | [[poc-app-service]] |
| PendingIntent / URI grant / implicit Intent | `returned-handle`, `interception` | [[poc-app-intent]] |
| deep-link to WebView sink | `scenario-page` | [[poc-app-webview]] |
| framework Binder / system service | `binder-caller` | [[poc-framework-service]] |

## Cross-Reference Rules

- [[poc-app-intent]] handles PendingIntent abuse regardless of which component delivers it.
- [[poc-app-activity]] handles task hijack, clickjacking, and lifecycle misuse even when the trigger originates from a Service or Receiver.
- [[poc-framework-service]] always needs hidden-API access; do not mix hidden-API setup into ordinary app-component PoCs.
- [[poc-base]] defines registration shape, success signal standards, and support component rules shared by all references.
- [[poc-webview|poc-app-webview]] is the main server-side pattern; all other references are primarily Android-side.
