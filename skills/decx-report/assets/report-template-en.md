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
| `{{issue.id}}` | `{{issue.rating}}` | `{{issue.title}}` | `{{issue.entrypoint}}` | `{{issue.impact}}` |

## {{issue.id}} {{issue.title}}

### 1. Target Context

- Target: `{{issue.target}}`
- Entrypoint: `{{issue.entrypoint}}`
- Trigger: `{{issue.trigger}}`
- Impact: `{{issue.impact}}`

### 2. Issue Explanation

- Reachability: `{{issue.reachability}}`
- Control: `{{issue.control}}`
- Guard: `{{issue.guard}}`
- Sink: `{{issue.sink}}`
- Evidence: `{{issue.evidence}}`

### 3. Composition Analysis

- Verdict: `{{issue.compositionVerdict}}`
- Detail: `{{issue.compositionDetail}}`

### 4. Remediation

`{{issue.remediation}}`
