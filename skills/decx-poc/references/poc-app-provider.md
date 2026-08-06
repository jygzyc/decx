---
name: poc-app-provider
description: Provider PoC routing for query, file, call, batch, getType, and grants.
---

# Provider PoC Reference

## Matrix

| Signal | Shape | Support |
|---|---|---|
| query / SQL injection / `getType()` | `direct-trigger` | none |
| file/path access | `direct-trigger` | none |
| `call()` / batch | `direct-trigger` | none |
| returned grant / FileProvider chain | `returned-handle` | capture step only if proven |

## Required Spec Fields

- provider authority
- URI/path/method/batch body
- selection/sort/order args, if used
- grant handle source, if used
- successSignal

## Implementation Slots

- call exactly one provider API family from the spec;
- do not invent grant acquisition.

## Exploit Techniques

- `openFile()` mode quirks: (a) mode `"rw"` checks only the write permission and ignores read; (b) on older versions `"rt"`/`"ra"` were accepted and only read-checked (truncate slipped through) — Android 17+ throws.
- system-triggered access: a protected provider's `openFile()`/`getType()` can be fired by the system, e.g. put the URI into an icon the system displays; on old patch levels `ActivityManager.openContentUri()` let the system open it as itself and hand back the fd.
