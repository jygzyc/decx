---
name: poc-app-activity
description: Activity PoC routing for exported access, redirect, result, task/UI, and lifecycle findings.
---

# Activity PoC Reference

## Matrix

| Signal | Shape | Support |
|---|---|---|
| exported direct launch / redirect / fragment / traversal | `direct-trigger` | none |
| `setResult()` or returned handle | `returned-handle` | helper Activity if capture is required |
| task hijack / clickjacking / lifecycle | `ui-assisted` | helper Activity or overlay only if spec requires |

## Required Spec Fields

- target package
- activity class
- action/data/categories/extras
- nested Intent or returned handle, if used
- successSignal

## Implementation Slots

- build one launch/capture/UI-assisted method.
