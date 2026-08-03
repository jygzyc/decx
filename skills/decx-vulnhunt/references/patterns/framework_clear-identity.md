---
name: clear-identity
track: framework
---

# clear-identity

## Match
`Binder.clearCallingIdentity()` / `withCleanCallingIdentity()` block wraps attacker-influenced work before authorization, target validation, user binding, or provider/launch/file sink is complete.

## Non-obvious
- `withCleanCallingIdentity(lambda)` obscures the restored block scope — easy to miss in review
- `finally { restoreCallingIdentity(token); }` must cover EVERY return path; exception path skipping fence is the recurring bug
- Service-owned callback/observer runs as service (no caller identity) and forwards into privileged **protocol writer** — delimiter mismatch between list split (`,`) and protocol delimiter (`\n`) is the injection point, not obvious string escaping
- Protocol writer sees `argumentCount` + `attackerText` as separate lines; trusting caller-supplied count or unescaped control chars is the inject point
- Privileged protocol parser receiving attacker text after identity clear executes under system identity

## Reject
Cleared block does only constant forwarder work, every attacker-controlled branch validated before clearing, `finally` covers all returns, or payloads escaped at source.
