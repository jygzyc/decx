---
name: poc-app-broadcast
description: Broadcast PoC routing for direct send, ordered interception, permission bypass, and leaks.
---

# Broadcast PoC Reference

## Matrix

| Signal | Shape | Support |
|---|---|---|
| dynamic receiver / permission bypass | `direct-trigger` | none or declared permission |
| ordered broadcast mutation | `interception` | runtime receiver |
| global broadcast leak | `interception` | runtime receiver |

## Required Spec Fields

- action
- extras/categories
- permission, if required
- ordered result fields, if used
- successSignal

## Implementation Slots

- direct-send or register-then-trigger exactly as spec states;
- do not add receiver if no capture/interception is required.
