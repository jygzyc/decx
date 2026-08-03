---
name: poc-app-webview
description: WebView PoC routing for deep-link driven hosted payloads.
---

# WebView PoC Reference

## Shape

Use `scenario-page` when the spec proves attacker-controlled URL/HTML reaches WebView.

## Required Spec Fields

- deep link prefix
- victim package/activity
- controlled URL parameter or HTML source
- payload action
- successSignal

## Implementation Slots

- add one link variant in `server/public/index.html` or `scenario.js`;
- add one payload block in `server/public/payload.html`;
- optionally register helper-app trigger if the spec requires app-side launch;
- log `successSignal`.

## Variants

- raw deep link
- browser `intent://` URL
- equivalent adb command
