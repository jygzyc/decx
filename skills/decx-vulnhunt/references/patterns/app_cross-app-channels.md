---
name: cross-app-channels
track: app
---

# cross-app-channels

## Match
App exposes or consumes data through channels beyond explicit Intent IPC: clipboard, accessibility service, notification listener, shared storage, account manager, drag-and-drop, or content provider with grant.

## Direction hints
- **Clipboard** (`ClipboardManager.setPrimaryClip`/`getPrimaryClip`): sensitive data placed on clipboard is readable by ANY app with clipboard permission; attacker app polls clipboard in background. Look for: password fields copying to clipboard, 2FA codes, auth tokens.
- **Accessibility service**: `AccessibilityService` can read screen content of ANY app including password fields, inject touch events, and observe all UI state. Look for: apps that request `BIND_ACCESSIBILITY_SERVICE` and expose sensitive observations, or apps whose protected UI is accessible to an attacker's accessibility service.
- **Notification listener** (`NotificationListenerService`): receives ALL notifications including content with OTPs, messages, credentials. Look for: notifications carrying sensitive data visible to any registered listener.
- **Shared storage** (`/sdcard`, `getExternalStorageDirectory`): world-readable files; any app with storage permission can read. Look for: databases, config files, tokens, cookies written to external storage.
- **Account Manager** (`AccountAuthenticator`): custom account type's authenticator activity returns an Intent via `AccountManagerService` response — this is the LaunchAnyWhere primitive (chains with `intent-redirect` and `validation-gap`). Look for: authenticator returning caller-influenced Intent in `setAccountAuthenticatorResult`.
- **Drag-and-drop** (`ClipData`): `StartDragAndDrop` with `ClipData` crosses app boundaries; receiving app processes attacker-controlled `ClipData` items including content URIs with grants.
- **Share sheet** (`ACTION_SEND` / `ACTION_SEND_MULTIPLE`): target app processes attacker-controlled URI/text/stream — common chain entry into `provider-leak` via `_display_name` path traversal.

## Reject
Channel carries only public data, receiving app validates and sanitizes all cross-app input, or no sensitive data crosses the channel.
