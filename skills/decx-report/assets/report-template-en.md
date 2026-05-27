# Module Security Analysis Report

## Basic Information

| Field | Value |
|------|-------|
| Target | `<analysis.meta.target>` |
| Scope | `<analysis.context.scope>` |
| Session | `<analysis.meta.sessionName>` |
| Android / Device | `<analysis.meta.serial or N/A>` |
| Analysis Date | `YYYY-MM-DD` |

---

## Attack-Surface Coverage Summary

| Metric | Value |
|------|-------|
| Total Surfaces | `<analysis.stats.total>` |
| `statically-supported` | `<analysis.stats.staticallySupported>` |
| `candidate` | `<analysis.stats.candidate>` |
| `rejected` | `<analysis.stats.rejected>` |
| Coverage Complete | `<analysis.stats.complete>` |

> Summarize whether coverage is complete and call out the remaining candidate surfaces.

---

## Issue 1: [Risk] Vulnerability Title

### 1. Vulnerability Analysis

#### Background

> Describe the failed security boundary, attacker-controlled input, reachable entrypoint, and impacted asset.

#### Full Call Chain

> Start from the victim component entrypoint, Binder Stub, or manager facade entry and end at the sensitive sink.
> Attacker actions belong only in `Attack Path`.

```text
<victim.entryPoint>
  -> <source>
  -> <intermediate>
  -> <sink>
```

#### Code Analysis

> Use numbered evidence points. Each point must support reachability, controllability, bypassability, or impact.

1. **Reachable entrypoint**

```text
<evidence>
```

2. **Missing or bypassable protection**

```text
<evidence>
```

3. **Sensitive operation reached**

```text
<evidence>
```

#### Bypass Conditions / Uncertainties

> State which guards, permissions, identity checks, or user-state assumptions are bypassed and which remain uncertain.

### 2. Attack Path

#### Target Surface

| Field | Value |
|------|-------|
| Target ID | `<finding.targetId>` |
| Type / Service | `<target.context.type or serviceName>` |
| Entry | `<finding.entryPoint>` |
| Permission / Interface | `<target.context.permission or interface>` |

#### Exploitation Steps

> Describe only actions a third-party attacker can realistically perform.

1. `<step>`
2. `<step>`
3. `<step>`

### 3. Visible Impact

> State the real observable consequence.

### 4. Rating Rationale

> Map the impact to the risk-rating rules and justify the selected rating.

### 5. Remediation

> Provide concrete fixes for entry protection, caller identity validation, permission scope, input validation, or sink-side authorization.

---

## Residual Candidate Surfaces

| Target ID | Type / Service | Current State | Missing Proof |
|-----------|----------------|---------------|---------------|
| `<targetId>` | `<type>` | `candidate` | `<analysis.missingProof>` |
