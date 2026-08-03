# DECX Security Analysis Report

## Basic Information

| Field | Value |
|---|---|
| Target | `{{target}}` |
| Scope | `{{scope}}` |
| Session | `{{sessionName}}` |
| Date | `{{date}}` |

## Findings Summary

| ID | Risk | Title | Entry | Impact |
|---|---|---|---|---|
| `{{issue.id}}` | `{{issue.rating}}` | `{{issue.title}}` | `{{issue.entry}}` | `{{issue.impact}}` |

## {{issue.id}} {{issue.title}}

### 1. Target Context

- Target kind: `{{issue.targetKind}}`
- Entry: `{{issue.entry}}`
- Trigger: `{{issue.trigger}}`
- Impact: `{{issue.impact}}`

### 2. Issue Explanation

- Reachability: `{{issue.reachability}}`
- Control: `{{issue.control}}`
- Guard / identity: `{{issue.guardOrIdentity}}`
- Sink: `{{issue.sink}}`
- Evidence path: `{{issue.evidencePath}}`

### 3. Composition Analysis

`{{issue.composition}}`

### 4. Remediation

`{{issue.remediation}}`
