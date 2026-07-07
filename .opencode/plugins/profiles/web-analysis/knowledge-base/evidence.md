# Evidence and Rating Gate

## Candidate-to-finding gate

Promote only if all are proven with concrete evidence:

1. Reachable: attacker can trigger the path.
2. Controllable: attacker controls the security-relevant field or object.
3. Deeply traced: value is followed through helpers, IPC, component/WebView/provider/Binder/identity/async boundaries to sink or blocker.
4. Impactful: attacker gains or changes something security-relevant.

Required evidence fields: entrypoint, controlled field, call chain, guard result, sink argument, visible impact, and uncertainty if static proof stops short.

## Severity

| Rating | Use when |
|---|---|
| `CRITICAL` | remote or low-friction system/root/trusted-domain code execution, persistent device compromise, remote takeover, silent install, or unrecoverable device DoS |
| `HIGH` | high-value data disclosure, app-sandbox arbitrary read, credential/token theft, code execution in app process, local privileged process execution, meaningful security interaction bypass |
| `MEDIUM` | real bounded impact requiring local app, interaction, device/version condition, or yielding limited protected data/action |
| `LOW` | fragile or limited UI/social/recon impact with low-value data or temporary effect |
| `IGNORED` | unreachable, non-security, crash-only, no visible impact, missing obfuscation, standalone `allowBackup`, TLS pinning absence without exploit chain, hardcoded unreachable values |

Raise when chaining is clean, no malicious install is needed, effect persists, mitigation is bypassed, or target is broadly deployed. Lower when physical access, narrow version/device scope, multiple confirmations, unstable exploitation, or debug-only behavior applies.

Final finding notes must include `Visible Impact`, `Rating Rationale`, and `Bypass Conditions / Uncertainties` when applicable.
