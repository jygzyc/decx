# Framework Vulnerability References

Use references as framework vulnerability pattern knowledge. `SKILL.md` controls workflow and evidence states; this directory helps identify statically supportable framework-service bugs.

## Layers

| Layer | Files | Purpose |
|---|---|---|
| Overview | `overviews/service.md` | map Binder/service entrypoints to pattern cards |
| Pattern cards | `patterns/*.md` | define source/sink/guard/evidence/rejection/rating rules |
| Casebooks | `casebooks/*.md` | preserve exploit-chain examples as abstract shapes |
| Rating | `risk-rating.md` | final report gate and severity authority |

## Load Order

1. Start with `overviews/service.md`.
2. Load the one or two pattern cards matching the traced code behavior.
3. Use `casebooks/framework-service-cases.md` only for comparable exploit-chain shapes.
4. Use `risk-rating.md` before moving a candidate to `statically-supported`.

## Coverage Matrix

| Knowledge area | Canonical pattern |
|---|---|
| missing permission, app-op, UID/package, or user restriction gate | `patterns/framework-service-permission-missing.md` |
| `clearCallingIdentity()` / clean identity misuse | `patterns/framework-service-clear-identity.md` |
| caller-supplied package/user/UID attribution confusion | `patterns/framework-service-identity-confusion.md` |
| cross-user/profile target confusion | `patterns/framework-service-cross-user.md` |
| privileged Intent launch, redirect, broadcast, grant, or PendingIntent dispatch | `patterns/framework-service-intent-launch.md` |
| framework-created or framework-sent PendingIntent identity reuse | `patterns/framework-service-pendingintent.md` |
| ContentProvider proxy, URI grant, or provider-backed file descriptor access | `patterns/framework-service-content-provider-proxy.md` |
| protected framework data returned to lower-privileged callers | `patterns/framework-service-data-leak.md` |
| TOCTOU, async, callback, token, or mutable-state race | `patterns/framework-service-race-condition.md` |
