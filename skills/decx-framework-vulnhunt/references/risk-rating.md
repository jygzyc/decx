# Reference - Rating - Vulnerability Risk Rating

Reference guidance for rating Android security findings.

## Contents

- [1. Mandatory Exploitability Gate](#1-mandatory-exploitability-gate)
- [2. Rating Levels](#2-rating-levels)
- [3. Detailed Rating Guidance](#3-detailed-rating-guidance)
- [4. Adjustment Factors](#4-adjustment-factors)
- [5. Mandatory Rating Notes](#5-mandatory-rating-notes)

## 1. Mandatory Exploitability Gate

Report a finding only if all four conditions are satisfied:

1. **Reachable**: the attacker can trigger the path
2. **Controllable**: the attacker can influence the security-relevant input
3. **Deeply traced**: the controlled value is followed through Binder boundaries, identity transitions (`clearCallingIdentity`), async handlers, callbacks, cross-service calls, and provider/file/launch paths to the sink or blocker
4. **Impactful**: the path causes a visible security consequence

These four conditions are checked mechanically by the `gate` command — Reachable↔`binder-reachability`, Controllable↔`control`, Deeply traced↔`service-entrypoint`+`identity`+`guard`+`sink`, Impactful↔`impact`. Run it before promotion (threshold `0.8`, stricter than app because framework bugs carry higher blast radius):

```bash
node skills/decx-analysis-core/scripts/decx-graph.mjs gate <graph-dir> --from <service-entrypoint-fact> --kinds service-entrypoint,binder-reachability,control,identity,permission-guard,sink,impact --threshold 0.8
```

Promote only when the gate returns `complete: true` **and** `meets_threshold: true`. If either fails, do not report it. Keep it only as an intermediate analysis record, chain pivot, or a `fact --kind hypothesis` (unresolved candidate) until the missing gate is proven.

### Reachable

- Is the target surface externally invocable?
- Is a permission required, and can the attacker actually satisfy it?
- Does the chain require user interaction?

### Controllable

- Can the attacker control the Intent extras, URI, path, Binder payload, or message body?
- Can the attacker influence a nested Intent, `ClipData`, `PendingIntent`, scan result, or activity result?
- Can the attacker shape the exact fields used by the sink?

### Impactful

Only count impacts that are visible and meaningful:

- sensitive data disclosure
- credential theft
- unauthorized actions
- privilege escalation
- code execution
- persistent denial of service

Do not report:

- crash-only malformed input issues
- theoretical issues with no visible impact
- permission declarations that cannot be abused in practice

## 2. Rating Levels

| Rating | Core meaning |
|--------|--------------|
| `CRITICAL` | remote or low-friction exploitation with system-level, root-level, or persistent device impact |
| `HIGH` | high-value local or remote compromise, including app-sandbox disclosure, strong credential theft, or privilege misuse |
| `MEDIUM` | real but bounded impact, often requiring local installation, additional conditions, or stronger interaction |
| `LOW` | limited impact, fragile conditions, or primarily social-engineering/UI abuse |
| `IGNORED` | not security-relevant or not exploitable |

## 3. Detailed Rating Guidance

### CRITICAL

Use `CRITICAL` when the finding enables any of the following:

- code execution in a privileged process
- root acquisition
- code execution in TEE or equivalent trusted domains
- unauthorized access to highly protected authentication material that can directly cause financial or identity harm
- persistent device-level DoS requiring factory reset, reflashing, or equivalent recovery
- remote silent app installation
- remote device takeover
- persistent tampering with device identity or secure boot state

### HIGH

Use `HIGH` when the finding enables any of the following:

- remote disclosure of high-sensitivity user data such as photos, contacts, recordings, or equivalent
- code execution in a normal app process
- arbitrary read of app-sandbox data
- local code execution in a privileged process
- acquisition of `system`-level capabilities
- local persistent DoS
- no-interaction theft of app credentials or tokens
- low-friction disclosure of sensitive user data or credentials
- local bypass of meaningful security-related user interaction
- local unauthorized dangerous actions such as launching protected targets, silent dialing, or privileged broadcasts

### MEDIUM

Use `MEDIUM` when the finding enables any of the following:

- app-level remote DoS
- local arbitrary read of a bounded but real data set
- local disclosure of user-sensitive but non-system data
- app-level lock or policy bypass
- local execution in an ordinary app process
- local access to protected data that normally requires user-granted permission
- credential theft that still requires stronger interaction or additional conditions
- logic flaws that enable real user deception or phishing

### LOW

Use `LOW` when the finding has real but limited security value, for example:

- requires multiple user interactions
- depends on highly specific physical or environmental conditions
- primarily causes UI deception
- leaks low-value or non-user-sensitive information
- only supports weak reconnaissance
- temporary crash/restart behavior with no broader security effect

### IGNORED

Do not report the following:

- missing obfuscation
- repackaging resistance issues
- `allowBackup=true` by itself
- hardcoded values that remain unreachable to attackers
- TLS pinning absence without a validated exploit chain
- malformed-input surface crashes with no broader impact
- purely functional or compatibility bugs

## 4. Adjustment Factors

These factors adjust two things: the **rating level** (§2) and the **Fact confidence** set when the evidence is written. A fact's confidence reflects evidence quality, not severity; adjustment factors that make the evidence firmer raise confidence, factors that make it shakier lower it.

### Confidence mapping (Fact `--confidence`)

Raise confidence toward `1.0` (proven) when the evidence is:

- read directly from decompiled framework source / AIDL / system service dump that can be re-read
- statically traced across Binder boundaries with no cross-version / OEM-build assumption
- confirmed by a re-readable artifact (xref, CFG, Binder transaction dump)

Lower confidence into the `0.5 – 0.7` (inferred) band when the evidence depends on:

- a cross-process Binder boundary or `clearCallingIdentity` transition resolved by assumption
- behaviour observed only on one OEM/version/build without source confirmation
- a permission-guard / appop-guard bypass assumed from declaration only

Lower confidence into the `0.2 – 0.4` (speculative) band when the evidence is:

- an observed pattern shape only, with unconfirmed Binder reachability
- an identity confusion assumed possible but not demonstrated at the trust boundary

### Rating adjustment

Raise the rating when:

- the bug chains cleanly with another weakness
- exploitation requires no malicious app installation
- the effect persists after the initial trigger
- the chain bypasses a modern Android mitigation
- the vulnerable app or service is broadly deployed

Lower the rating when:

- physical access is required
- the issue is version-specific or device-specific
- multiple user confirmations are required
- the impact scope is narrow
- exploitation is highly unstable
- the issue affects only debug builds

## 5. Mandatory Rating Notes

Every final finding must include:

- `Visible Impact`: what the attacker actually gains or changes
- `Rating Rationale`: one sentence mapping the finding to the categories above
- `Bypass Conditions / Uncertainties`: only when protection cannot be confirmed statically

Examples:

- "HIGH because the exported provider allows arbitrary reads of app-sandbox account data"
- "MEDIUM because exploitation requires a malicious local app and yields only a bounded settings change"
- "Candidate only: the custom permission is defined outside the current trust boundary, so bypassability depends on whether the defining party is attacker-controlled or the permission is non-signature"
