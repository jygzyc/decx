---
name: cross-app-channels
track: app
---

# cross-app-channels

## Match
App exposes or consumes data through channels beyond explicit Intent IPC: clipboard, accessibility service, notification listener, shared storage, account manager, drag-and-drop, or content provider with grant.

## Direction hints
- **Clipboard**: signal — sensitive values (passwords, OTPs, tokens) via `ClipboardManager.setPrimaryClip`; sink — any app polling `getPrimaryClip`
- **Accessibility service**: signal — app requests `BIND_ACCESSIBILITY_SERVICE` or exposes sensitive UI; sink — attacker service reads screen content (including password fields) or injects touches
- **Notification listener**: signal — notifications carry OTPs/messages/credentials; sink — any registered `NotificationListenerService` reads all notification content
- **Shared storage**: signal — databases/config/tokens written to external storage; sink — any app with storage permission reads them
- **Account Manager**: signal — `AccountAuthenticator` returns caller-influenced Intent in `setAccountAuthenticatorResult`; sink — framework launches it under system identity (LaunchAnyWhere; chains with `intent-redirect`)
- **Drag-and-drop**: signal — `ClipData` crosses apps via drag-and-drop; sink — receiving app processes attacker URIs carrying grants
- **Share sheet**: signal — `ACTION_SEND`/`ACTION_SEND_MULTIPLE` target handles attacker URI/text/stream; sink — `provider-leak` `_display_name` path traversal

## Reject
Channel carries only public data, receiving app validates and sanitizes all cross-app input, or no sensitive data crosses the channel.
