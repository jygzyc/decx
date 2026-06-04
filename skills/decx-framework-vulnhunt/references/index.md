# Framework Vulnerability References

Use references as framework vulnerability pattern knowledge. `SKILL.md` controls workflow and evidence states; this directory helps identify statically supportable framework-service bugs.

## Layers

| Layer | Files | Purpose |
|---|---|---|
| Overview | [[overviews/service]] | map Binder/service entrypoints to pattern cards and chain pivots |
| Pattern cards | [[patterns/framework-service-permission-missing]], [[patterns/framework-service-clear-identity]], [[patterns/framework-service-identity-confusion]] | define source/sink/guard/evidence/rejection/rating rules |
| Casebooks | [[casebooks/framework-service-cases]] | preserve exploit-chain examples as abstract shapes |
| Rating | [[risk-rating]] | final report gate and severity authority |

## Load Order

1. Start with `Composite Framework Chains`.
2. Load [[overviews/service]] to map Binder entrypoints and privileged sinks.
3. Load the one or two matching pattern cards for source/sink/guard/reject rules. Do not load sibling cards by component name alone — only when the trace crosses that boundary.
4. Use [[casebooks/framework-service-cases]] only for comparable exploit-chain shapes.
5. Use `Single Pattern Routing` only for standalone bugs.
6. Apply [[risk-rating]] before moving a candidate to `statically-supported`.

## Composite Framework Chains

Framework findings are strongest when the trace crosses caller identity, user/profile, async, provider, or launch boundaries. Prefer this matrix before single-pattern lookup.

| Chain shape | High-signal code behavior | Load first |
|---|---|---|
| missing permission/app-op -> `clearCallingIdentity` -> privileged operation | Binder method lacks caller gate before identity is cleared or before protected callee executes under system identity | [[overviews/service]], [[patterns/framework-service-permission-missing]], [[patterns/framework-service-clear-identity]], [[casebooks/framework-service-cases]] |
| identity confusion -> cross-user/profile action | caller-supplied package, UID, user ID, attribution tag, or profile target is trusted across user/profile boundary | [[patterns/framework-service-identity-confusion]], [[patterns/framework-service-cross-user]], [[casebooks/framework-service-cases]] |
| privileged Intent launch -> PendingIntent / URI grant | service launches or grants using caller-controlled `Intent`, `Uri`, `Bundle`, `PendingIntent`, or flags | [[patterns/framework-service-intent-launch]], [[patterns/framework-service-pendingintent]], [[patterns/framework-service-content-provider-proxy]], [[casebooks/framework-service-cases]] |
| content-provider proxy -> protected data/file leak | service queries, opens, updates, or grants provider/file access for caller-controlled URI under privileged identity | [[patterns/framework-service-content-provider-proxy]], [[patterns/framework-service-data-leak]], [[patterns/framework-service-clear-identity]], [[casebooks/framework-service-cases]] |
| race/async callback -> stale permission or identity state | permission/user/package check occurs before mutable state, callback, token reuse, delayed handler, or async operation changes target | [[patterns/framework-service-race-condition]], [[patterns/framework-service-permission-missing]], [[patterns/framework-service-identity-confusion]], [[casebooks/framework-service-cases]] |

## Single Pattern Routing

Use this as fallback when the trace is clearly standalone and does not pivot through another privileged boundary.

| Knowledge area | Canonical pattern |
|---|---|
| missing permission, app-op, UID/package, or user restriction gate | [[patterns/framework-service-permission-missing]] |
| `clearCallingIdentity()` / clean identity misuse | [[patterns/framework-service-clear-identity]] |
| caller-supplied package/user/UID attribution confusion | [[patterns/framework-service-identity-confusion]] |
| cross-user/profile target confusion | [[patterns/framework-service-cross-user]] |
| privileged Intent launch, redirect, broadcast, grant, or PendingIntent dispatch | [[patterns/framework-service-intent-launch]] |
| framework-created or framework-sent PendingIntent identity reuse | [[patterns/framework-service-pendingintent]] |
| ContentProvider proxy, URI grant, or provider-backed file descriptor access | [[patterns/framework-service-content-provider-proxy]] |
| protected framework data returned to lower-privileged callers | [[patterns/framework-service-data-leak]] |
| TOCTOU, async, callback, token, or mutable-state race | [[patterns/framework-service-race-condition]] |
