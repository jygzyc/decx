---
decx: decx
patterns: 31
---

# decx pattern index

One row per pattern page: `` - `slug` — trigger ``, grouped by track. The wiki is the
maintenance layer: a pattern consolidates what the raw traces showed. Execution
procedures live in `skills/<name>/SKILL.md` and must stay complete on their own.

Read a page with `decx_read` (`path: "patterns/<slug>.md"`); add or change
pages only through `decx_maintain`.

<!-- decx:index:start -->
### Android app (14)
- `android-app-archive_extraction` — App unpacks a downloaded archive (zip/apk/jar/tar) or loads code from an attacker-influenced path.
- `android-app-broadcast` — Exported <receiver>, or a dynamic registerReceiver without RECEIVER_NOT_EXPORTED.
- `android-app-client_controlled_auth_input` — An authorization, filter or scope decision takes its input from the caller's own request payload instead of a platform-owned object.
- `android-app-exported_access` — Component reached through manifest export, deep link, dynamic receiver, or bindable service.
- `android-app-fragment_ui` — UI/state trust abuse via caller-controlled Fragment class, task affinity/launch mode, overlay, or lifecycle state reuse.
- `android-app-implicit_intent_hijack` — Sensitive data, URI grant, callback, or result sent through implicit Intent resolution (no explicit component).
- `android-app-intent_redirect` — Exported entry, WebView/IntentScheme router, PendingIntent send, or notification path forwards a caller-controlled Intent downstream.
- `android-app-object_parsing` — One process validates serialized data but a later process deserializes it into different keys/types.
- `android-app-pendingintent` — Attacker influences PendingIntent creation, accepts one as extra, or triggers dispatch via notification/widget/alarm/shortcut/callback.
- `android-app-provider_leak` — Exported or grant-reachable ContentProvider exposes data, handles, MIME, or writes attacker-controlled values to protected rows/files.
- `android-app-service_cmd` — Exported service, IntentService, AIDL/Binder, Messenger, or Job/WorkManager consumes attacker-controlled command input.
- `android-app-uri_grant` — Caller-controlled flow carries a content:// URI, ClipData, or FLAG_GRANT_* into a grant path.
- `android-app-webview_entry` — Attacker-controlled URL or content reaches WebView loadUrl/loadDataWithBaseURL/evaluateJavascript without host/path/scheme allowlist.
- `android-app-webview_exploit` — WebView capabilities exploited once attacker content is loaded: JS bridge, file/content access, cookie theft, intent scheme dispatch.

### Android framework (9)
- `android-framework-clear_identity` — Binder.clearCallingIdentity() or withCleanCallingIdentity() wraps attacker-influenced work before a security check completes.
- `android-framework-content_provider_proxy` — Binder input reaches ContentResolver/provider proxy/URI grant/FD/call/stored grant under system/cleared/framework identity.
- `android-framework-identity_confusion` — Service trusts caller-supplied identity fields instead of deriving them from Binder.getCallingUid() or PackageManager.
- `android-framework-intent_launch` — Binder input reaches a framework Intent operation under privileged identity.
- `android-framework-native_surface` — Android device runs native services (C/C++) accessible via Unix domain socket, HIDL, or vendor AIDL — outside the Java framework layer.
- `android-framework-pendingintent` — Framework service creates, stores, mutates, sends, cancels or accepts a PendingIntent using caller-controlled fields.
- `android-framework-permission_missing` — Binder-exposed framework method performs privileged work before a non-bypassable permission, app-op, UID-package or user-restriction check.
- `android-framework-transition_control` — Lower-privileged caller registers or influences a window transition path — organizer, player, token, or transaction.
- `android-framework-validation_gap` — Framework service validates an Intent, URI or component at time T1, then executes it at time T2.

### Android PoC (7)
- `android-poc-activity` — An exported Activity is the entry: direct launch, redirect, fragment/traversal, setResult() capture, or task/UI/lifecycle abuse.
- `android-poc-broadcast` — Broadcast or receiver is the entry: direct send, ordered interception, permission bypass, or global leak.
- `android-poc-framework_service` — Framework Binder or system service is the target, including race-condition drivers (binder-caller shape).
- `android-poc-harness` — Building or validating a poc-<target> Android PoC: environment, fixed harness structure, or proof that the specified path executed.
- `android-poc-provider` — ContentProvider is the entry: query/SQL injection/getType(), file or path access, call()/batch, or a returned grant/FileProvider chain.
- `android-poc-service` — Service is the entry: onStartCommand() extras/action, AIDL/Binder exposure, Messenger protocol, or foreground notification observation.
- `android-poc-webview` — WebView deep link delivers an attacker-controlled URL or HTML (scenario-page shape).

### Native (1)
- `native-kernel_modules` — Analysing a vendor kernel module with no vendor source or linked image when the attack path must be mapped from a reachable entry point.
<!-- decx:index:end -->
